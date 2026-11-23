const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { normPhone, normEmail } = require("../utils/helperFunction");
const { safeUser } = require("../utils/viewHelper");
const { getPlatformSettings, createShop, audit } = require("../utils/platform");
const { queueSms } = require("../services/sms/sms");

/** Find a shop user by email (has "@") or by phone (digits; +880 / 880 match the local 01… form). */
const findByLogin = async (identifier) => {
  const id = String(identifier || "").trim();
  if (!id) return null;
  if (id.includes("@")) return prisma.user.findUnique({ where: { email: normEmail(id) } });
  const phone = normPhone(id);
  return phone ? prisma.user.findUnique({ where: { phoneKey: phone } }) : null;
};

const expiresIn = () => process.env.JWT_EXPIRES_IN || "1d";

/** Token for a shop user. `extra` carries impersonation (imp, impName) when a platform person opens the shop. */
const signShopToken = (user, extra = {}, ttl = expiresIn()) =>
  jwt.sign({ id: user.id, storeId: user.storeId, companyId: user.companyId, roleId: user.roleId, ...extra }, process.env.JWT_SECRET, { expiresIn: ttl });

const signPlatformToken = (pu) => jwt.sign({ id: pu.id, kind: "platform" }, process.env.JWT_SECRET, { expiresIn: expiresIn() });

const contactLine = (s) => [s.supportPhone, s.supportEmail].filter(Boolean).join(" / ");

/** Platform person → the shape the client gets. */
const safePlatformUser = ({ password, isDemo, ...u }) => ({ ...u, demo: !!isDemo });

/**
 * Sign in with email or phone + password.
 * Shop users get a shop token; platform people (email only) get a platform token.
 */
exports.login = async (req, res, next) => {
  try {
    const { identifier, password } = req.body;
    const wrong = () => apiError.unauthorized("Wrong email / phone or password");

    const user = await findByLogin(identifier);
    if (user) {
      if (!(await bcrypt.compare(String(password || ""), user.password))) throw wrong();
      if (user.status === "inactive") throw apiError.unauthorized("This user is inactive. Ask your admin to activate it.");
      const [store, employee, settings] = await Promise.all([
        prisma.store.findUnique({ where: { id: user.storeId }, select: { status: true, suspendReason: true } }),
        prisma.employee.findFirst({ where: { storeId: user.storeId, userId: user.id }, select: { status: true } }),
        getPlatformSettings(),
      ]);
      if (store?.status === "suspended") {
        const contact = contactLine(settings);
        throw apiError.forbidden(`This shop is suspended${store.suspendReason ? `: ${store.suspendReason}` : ""}.${contact ? ` Contact ${settings.brandName} at ${contact}.` : ""}`);
      }
      if (employee && employee.status !== "active") throw apiError.unauthorized("This SR is inactive. Ask your manager to activate the SR.");

      const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: dayjs().toISOString() } });
      logger.info(`Login successful: ${user.email || user.phone}`);
      return res.status(200).json({
        status: "success",
        message: "Login successful",
        data: { kind: "shop", user: safeUser(updated), accessToken: signShopToken(user) },
      });
    }

    const id = String(identifier || "").trim();
    const pu = id.includes("@") ? await prisma.platformUser.findUnique({ where: { email: normEmail(id) } }) : null;
    if (!pu || !(await bcrypt.compare(String(password || ""), pu.password))) throw wrong();
    if (pu.status !== "active") throw apiError.unauthorized("This account is inactive.");
    const updated = await prisma.platformUser.update({ where: { id: pu.id }, data: { lastLoginAt: dayjs().toISOString() } });
    logger.info(`Platform login: ${pu.email}`);
    return res.status(200).json({
      status: "success",
      message: "Login successful",
      data: { kind: "platform", user: safePlatformUser(updated), accessToken: signPlatformToken(pu) },
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    next(error);
  }
};

/** Tokens are stateless: the client forgets its token. */
exports.logout = async (req, res) => res.status(200).json({ status: "success", message: "Signed out", data: null });

/** What the login and sign-up pages need before anyone signs in. */
exports.getPublicInfo = async (req, res, next) => {
  try {
    const s = await getPlatformSettings();
    return res.status(200).json({
      status: "success",
      data: { brandName: s.brandName, signupEnabled: s.signupEnabled, trialDays: s.trialDays, supportPhone: s.supportPhone, supportEmail: s.supportEmail },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Self sign-up: a new business opens its own shop on a free trial and is signed in as its admin.
 * Body: { businessName, ownerName, phone, email, password, modules, shopType, district, thana }
 */
exports.signup = async (req, res, next) => {
  try {
    const s = await getPlatformSettings();
    if (!s.signupEnabled) throw apiError.forbidden("New sign-ups are closed. Contact us to open a shop.");
    const { businessName, ownerName, phone, email, password, modules, address, shopType, district, thana } = req.body;
    if (!String(businessName || "").trim()) throw apiError.badRequest("Enter your shop or business name");
    if (!phone) throw apiError.badRequest("Enter your mobile number");

    // the plan that gives what they picked (shop / dealer / both); the default sign-up plan when none does
    const match = await prisma.plan.findFirst({ where: { active: true, modules: modules || "both" }, orderBy: { sortOrder: "asc" } });
    const fallback = s.signupPlanId ? await prisma.plan.findFirst({ where: { id: s.signupPlanId, active: true } }) : null;
    const planId = match?.id || fallback?.id || null;
    const { store, user } = await prisma.$transaction((tx) =>
      createShop(tx, {
        businessName,
        modules,
        planId,
        address,
        shopType,
        district,
        thana,
        trialEndsAt: dayjs().add(s.trialDays, "day"),
        source: "signup",
        smsBalance: s.smsFreeCredits,
        owner: { name: ownerName, email, phone, password },
      }),
    );
    await audit(null, "shop.signup", { store, detail: `${user.name} · ${user.email || user.phone}` });
    logger.info(`New shop signed up: ${store.code}`);
    return res.status(201).json({
      status: "success",
      message: "Your shop is ready",
      data: { kind: "shop", user: safeUser(user), accessToken: signShopToken(user) },
    });
  } catch (error) {
    logger.error(`Signup error: ${error.message}`);
    next(error);
  }
};

/* ---------------- forgot password (SMS code) ---------------- */
const RESET_MINUTES = 10;
const RESET_ATTEMPTS = 5;
const SAME_ANSWER = "If this number belongs to an account, a 6-digit code is on its way by SMS.";

/**
 * Step 1: { phone } → a 6-digit code by SMS (free for the shop). The answer is the same whether or not
 * the number exists. In development with SMS in test mode the code comes back as `devCode`.
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const phone = normPhone(req.body.phone);
    if (!phone) throw apiError.badRequest("Enter your mobile number");
    const user = await prisma.user.findUnique({ where: { phoneKey: phone } });
    if (!user || user.status !== "active") return res.status(200).json({ status: "success", message: SAME_ANSWER, data: {} });

    const recent = await prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gte: dayjs().subtract(1, "hour").toDate() } } });
    if (recent >= 3) throw apiError.badRequest("Too many codes asked for. Try again in an hour or ask your admin.");

    const code = String(crypto.randomInt(100000, 1000000));
    await prisma.passwordReset.create({
      data: { userId: user.id, codeHash: await bcrypt.hash(code, 8), expiresAt: dayjs().add(RESET_MINUTES, "minute").toDate() },
    });
    const s = await getPlatformSettings();
    await queueSms({ storeId: user.storeId, to: user.phone, type: "otp", message: `${s.brandName}: your code to set a new password is ${code}. It works for ${RESET_MINUTES} minutes. Don't share it.` });

    const dev = process.env.NODE_ENV !== "production" && !s.smsLive;
    return res.status(200).json({ status: "success", message: SAME_ANSWER, data: dev ? { devCode: code } : {} });
  } catch (error) {
    logger.error(`Forgot password error: ${error.message}`);
    next(error);
  }
};

/** Step 2: { phone, code, password } → new password if the latest code matches. */
exports.resetPassword = async (req, res, next) => {
  try {
    const { code, password } = req.body;
    const phone = normPhone(req.body.phone);
    const wrong = () => apiError.badRequest("The code is wrong or has expired. Ask for a new one.");
    if (String(password || "").length < 6) throw apiError.badRequest("Password must be at least 6 characters");
    const user = phone ? await prisma.user.findUnique({ where: { phoneKey: phone } }) : null;
    if (!user) throw wrong();
    const reset = await prisma.passwordReset.findFirst({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: "desc" } });
    if (!reset || dayjs(reset.expiresAt).isBefore(dayjs()) || reset.attempts >= RESET_ATTEMPTS) throw wrong();
    if (!(await bcrypt.compare(String(code || "").trim(), reset.codeHash))) {
      await prisma.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
      throw wrong();
    }
    await prisma.$transaction([
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(String(password), 10), passwordChangedAt: dayjs().toISOString() } }),
    ]);
    logger.info(`Password reset by SMS code for user ${user.id}`);
    return res.status(200).json({ status: "success", message: "Password changed. Sign in with the new password.", data: null });
  } catch (error) {
    logger.error(`Reset password error: ${error.message}`);
    next(error);
  }
};

/** The signed-in shop user changes their own password. */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw apiError.badRequest("All fields are required");
    if (String(newPassword).length < 6) throw apiError.badRequest("Password must be at least 6 characters");

    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, password: true } });
    if (!(await bcrypt.compare(String(currentPassword), user.password))) throw apiError.badRequest("Current password is wrong");
    if (currentPassword === newPassword) throw apiError.badRequest("The new password is the same as the current one");

    await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(String(newPassword), 10), passwordChangedAt: dayjs().toISOString() },
    });
    logger.info(`Password changed successfully for userId: ${user.id}`);
    return res.status(200).json({ status: "success", message: "Password changed successfully", data: null });
  } catch (error) {
    logger.error(`Change password error: ${error.message}`);
    next(error);
  }
};

/**
 * Accounts listed on the login page (click one → login and password are filled in).
 * Development only (NODE_ENV != production). Listed only while the account still has DEMO_PASSWORD.
 */
exports.getDemoAccounts = async (req, res, next) => {
  try {
    const demoPassword = process.env.DEMO_PASSWORD;
    if (process.env.NODE_ENV === "production" || !demoPassword) {
      return res.status(200).json({ status: "success", data: [] });
    }
    const [platform, users] = await Promise.all([
      prisma.platformUser.findMany({ where: { isDemo: true }, orderBy: { createdAt: "asc" } }),
      prisma.user.findMany({ where: { isDemo: true }, orderBy: { createdAt: "asc" }, include: { role: { select: { name: true } } } }),
    ]);
    const accounts = [];
    for (const p of platform) {
      if (!(await bcrypt.compare(demoPassword, p.password))) continue;
      accounts.push({ id: p.id, name: p.name, role: p.role === "owner" ? "Platform owner" : "Platform support", login: p.email, loginWith: "email", password: demoPassword, status: p.status, platform: true });
    }
    for (const u of users) {
      if (!(await bcrypt.compare(demoPassword, u.password))) continue;
      accounts.push({
        id: u.id,
        name: u.name,
        role: u.role?.name || "—",
        login: u.loginWith === "phone" ? u.phone : u.email,
        loginWith: u.loginWith === "phone" ? "phone" : "email",
        password: demoPassword,
        status: u.status,
      });
    }
    return res.status(200).json({ status: "success", data: accounts });
  } catch (error) {
    logger.error(`Demo accounts error: ${error.message}`);
    next(error);
  }
};

module.exports.findByLogin = findByLogin;
module.exports.signShopToken = signShopToken;
module.exports.safePlatformUser = safePlatformUser;
