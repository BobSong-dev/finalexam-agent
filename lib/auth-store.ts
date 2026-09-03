import "server-only";

import { createHash, randomInt } from "node:crypto";
import { getWorkspace, saveOtpChallenge, consumeOtpChallenge } from "./workspace-store";
import type { WorkspaceState } from "./workspace-types";

const OTP_TTL_MS = 10 * 60_000;
const OTP_COOLDOWN_MS = 60_000;
// This runtime intentionally persists one workspace from one Node process;
// match the store's in-process write queue by coalescing concurrent sends here.
// Distributed deployments still need a shared reservation/rate-limit layer.
const otpRequestsInFlight = new Set<string>();

export class AuthError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "AUTH_ERROR") {
    super(message);
    this.name = "AuthError";
  }
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("请输入有效的邮箱地址。", 400, "INVALID_EMAIL");
  return email;
}

function otpSecret(): string {
  const secret = process.env.AUTH_OTP_SECRET?.trim();
  if (!secret || secret.length < 32) throw new AuthError("管理员尚未配置 AUTH_OTP_SECRET，邮箱验证暂不可用。", 503, "AUTH_NOT_CONFIGURED");
  return secret;
}

function hashOtp(email: string, code: string): string {
  return createHash("sha256").update(`${otpSecret()}\0${email}\0${code}`).digest("hex");
}

function schoolForEmail(email: string): string | undefined {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const mappings = (process.env.SCHOOL_EMAIL_DOMAINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const mapping of mappings) {
    const [configuredDomain, school] = mapping.split("=", 2).map((item) => item?.trim());
    if (configuredDomain && school && configuredDomain.toLowerCase() === domain) return school.slice(0, 120);
  }
  return undefined;
}

function providerUrl(): string {
  const value = process.env.EMAIL_PROVIDER_URL?.trim();
  if (!value) throw new AuthError("管理员尚未配置 EMAIL_PROVIDER_URL，邮箱验证暂不可用。", 503, "EMAIL_PROVIDER_NOT_CONFIGURED");
  let url: URL;
  try { url = new URL(value); } catch { throw new AuthError("EMAIL_PROVIDER_URL 配置无效。", 503, "EMAIL_PROVIDER_NOT_CONFIGURED"); }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
    throw new AuthError("生产环境的 EMAIL_PROVIDER_URL 必须使用 HTTPS。", 503, "EMAIL_PROVIDER_NOT_CONFIGURED");
  }
  return url.toString();
}

export async function requestEmailOtp(emailInput: unknown): Promise<{ email: string; expiresInSeconds: number }> {
  const email = normalizeEmail(emailInput);
  if (otpRequestsInFlight.has(email)) throw new AuthError("验证码已发送，请稍候再试。", 429, "OTP_COOLDOWN");
  // Set membership is established synchronously before the first await, so a
  // Promise.all burst for the same normalized email has exactly one sender.
  otpRequestsInFlight.add(email);
  try {
    const current = await getWorkspace();
    const recent = current.otpChallenges.find((challenge) => challenge.email === email && Date.now() - Date.parse(challenge.sentAt) < OTP_COOLDOWN_MS);
    if (recent) throw new AuthError("验证码已发送，请稍候再试。", 429, "OTP_COOLDOWN");

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const url = providerUrl();
    const codeHash = hashOtp(email, code);
    const providerToken = process.env.EMAIL_PROVIDER_TOKEN?.trim();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(providerToken ? { Authorization: `Bearer ${providerToken}` } : {}) },
      body: JSON.stringify({
        to: email,
        subject: "期末星图邮箱验证码",
        text: `你的验证码是 ${code}，有效期 10 分钟。如非本人操作，请忽略此邮件。`,
        purpose: "finale-email-verification",
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    if (!response || !response.ok) throw new AuthError("验证码邮件发送失败，请检查邮件服务配置后重试。", 502, "EMAIL_DELIVERY_FAILED");

    await saveOtpChallenge({
      email,
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    });
    return { email, expiresInSeconds: OTP_TTL_MS / 1000 };
  } finally {
    // Provider/config/storage failures must not strand the address in-flight;
    // with no persisted challenge, the caller can retry immediately.
    otpRequestsInFlight.delete(email);
  }
}

export async function verifyEmailOtp(emailInput: unknown, codeInput: unknown): Promise<{ workspace: WorkspaceState; schoolMatched: boolean }> {
  const email = normalizeEmail(emailInput);
  const code = typeof codeInput === "string" ? codeInput.trim() : "";
  if (!/^\d{6}$/.test(code)) throw new AuthError("验证码必须是 6 位数字。", 400, "INVALID_OTP");
  const workspace = await consumeOtpChallenge(email, hashOtp(email, code), schoolForEmail(email));
  return { workspace, schoolMatched: Boolean(schoolForEmail(email)) };
}
