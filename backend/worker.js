import YSWS_LIST from "./public/ysws.json";

const HC_AUTH_BASE = "https://auth.hackclub.com";
const HC_OAUTH_SCOPE = "openid profile email name slack_id verification_status";
const PUBLIC_COOKIE_KEYS = ["hcName", "hcEmail", "hcAvatar"];
const ADMIN_SLACK_ID = "U0828RTU7FE";
const MAX_AUDIT_EVENTS = 100;
const AUDIT_RETENTION_DAYS = 14;
const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const JOIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const JOIN_RATE_LIMIT_MAX_REQUESTS = 8;
const RSVP_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RSVP_RATE_LIMIT_MAX_REQUESTS = 12;
const KV_METRICS_KEY = "ops:metrics:v1";
const KV_AUDIT_KEY = "ops:audit:v1";
const KV_JOIN_RATE_LIMIT_PREFIX = "ops:rate-limit:join:";
const KV_RSVP_RATE_LIMIT_PREFIX = "ops:rate-limit:rsvp:";
const KV_RSVP_DONE_PREFIX = "ops:rsvp:done:";

function getRuntimeState() {
  if (!globalThis.__YSWS_RSVP_RUNTIME__) {
    globalThis.__YSWS_RSVP_RUNTIME__ = {
      startedAt: new Date().toISOString(),
      auditEvents: [],
      rateLimits: new Map(),
      kvHydrated: false,
      metrics: {
        auth: { success: 0, failure: 0 },
        join: { success: 0, failure: 0 },
        errors: { total: 0, byCode: {} },
      },
    };
  }

  return globalThis.__YSWS_RSVP_RUNTIME__;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const requestOriginHeader = request.headers.get("Origin") || "";
    const normalizeOrigin = (value) => {
      const input = String(value || "").trim();
      if (!input) return "";
      try {
        return new URL(input).origin;
      } catch {
        return input.replace(/\/+$/, "");
      }
    };
    const requestOrigin = normalizeOrigin(requestOriginHeader);
    const allowedOrigins = String(env.FRONTEND_ORIGIN || "")
      .split(",")
      .map((item) => normalizeOrigin(item))
      .filter(Boolean);
    const isAllowedOrigin =
      requestOrigin && allowedOrigins.includes(requestOrigin);
    const runtimeState = getRuntimeState();
    const kv = env.YSWS && typeof env.YSWS.get === "function" ? env.YSWS : null;
    const allowedChannels = new Set(
      YSWS_LIST.map((item) => String(item.channel || "").trim().toUpperCase()),
    );

    const corsHeaders = {
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };

    function withCors(response) {
      const headers = new Headers(response.headers);
      if (isAllowedOrigin) {
        headers.set("Access-Control-Allow-Origin", requestOrigin);
        for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    function jsonResponse(body, status = 200, headers = {}) {
      return withCors(
        new Response(JSON.stringify(body), {
          status,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
        }),
      );
    }

    function getDefaultMetrics() {
      return {
        auth: { success: 0, failure: 0 },
        join: { success: 0, failure: 0 },
        rsvp: { success: 0, failure: 0 },
        errors: { total: 0, byCode: {} },
      };
    }

    async function readKvJson(key, fallback) {
      if (!kv) return fallback;

      try {
        const value = await kv.get(key, "json");
        return value ?? fallback;
      } catch {
        return fallback;
      }
    }

    async function writeKvJson(key, value, options = {}) {
      if (!kv) return;

      try {
        await kv.put(key, JSON.stringify(value), options);
      } catch {
      }
    }

    function getRsvpDoneKey(slackId) {
      return `${KV_RSVP_DONE_PREFIX}${slackId}`;
    }

    function normalizeRsvpDoneState(value) {
      const next = {};

      for (const item of YSWS_LIST) {
        const channel = String(item.channel || "").trim().toUpperCase();
        if (!channel) continue;
        next[channel] = Boolean(value?.[channel]);
      }

      return next;
    }

    async function readUserRsvpDone(slackId) {
      if (!slackId || !kv) return normalizeRsvpDoneState({});
      const stored = await readKvJson(getRsvpDoneKey(slackId), {});
      return normalizeRsvpDoneState(stored || {});
    }

    async function writeUserRsvpDone(slackId, value) {
      const next = normalizeRsvpDoneState(value);
      if (!slackId || !kv) return next;
      await writeKvJson(getRsvpDoneKey(slackId), next);
      return next;
    }

    function runBackground(task) {
      if (!task) return;
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(task);
      }
    }

    async function hydratePersistentState() {
      if (runtimeState.kvHydrated || !kv) return;

      const [storedMetrics, storedAudit] = await Promise.all([
        readKvJson(KV_METRICS_KEY, null),
        readKvJson(KV_AUDIT_KEY, null),
      ]);

      runtimeState.metrics = {
        ...getDefaultMetrics(),
        ...(storedMetrics || {}),
        auth: {
          ...getDefaultMetrics().auth,
          ...(storedMetrics?.auth || {}),
        },
        join: {
          ...getDefaultMetrics().join,
          ...(storedMetrics?.join || {}),
        },
        rsvp: {
          ...getDefaultMetrics().rsvp,
          ...(storedMetrics?.rsvp || {}),
        },
        errors: {
          ...getDefaultMetrics().errors,
          ...(storedMetrics?.errors || {}),
          byCode: {
            ...getDefaultMetrics().errors.byCode,
            ...(storedMetrics?.errors?.byCode || {}),
          },
        },
      };
      runtimeState.auditEvents = Array.isArray(storedAudit)
        ? storedAudit.slice(0, MAX_AUDIT_EVENTS)
        : [];
      pruneAuditEvents();
      runtimeState.kvHydrated = true;
    }

    function persistMetrics() {
      if (!kv) return null;
      return writeKvJson(KV_METRICS_KEY, runtimeState.metrics);
    }

    function persistAudit() {
      if (!kv) return null;
      return writeKvJson(KV_AUDIT_KEY, runtimeState.auditEvents);
    }

    function pruneAuditEvents() {
      const cutoff = Date.now() - AUDIT_RETENTION_MS;
      const beforeCount = runtimeState.auditEvents.length;

      runtimeState.auditEvents = runtimeState.auditEvents
        .filter((event) => {
          const timestamp = Date.parse(event?.timestamp || "");
          return !Number.isNaN(timestamp) && timestamp >= cutoff;
        })
        .slice(0, MAX_AUDIT_EVENTS);

      const removedCount = beforeCount - runtimeState.auditEvents.length;
      if (removedCount > 0) {
        runBackground(persistAudit());
      }

      return removedCount;
    }

    function countError(code) {
      runtimeState.metrics.errors.total += 1;
      runtimeState.metrics.errors.byCode[code] =
        (runtimeState.metrics.errors.byCode[code] || 0) + 1;
      runBackground(persistMetrics());
    }

    function recordMetric(group, outcome) {
      if (!runtimeState.metrics[group]) return;
      runtimeState.metrics[group][outcome] += 1;
      runBackground(persistMetrics());
    }

    function recordEvent(type, outcome, details = {}) {
      pruneAuditEvents();

      runtimeState.auditEvents.unshift({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type,
        outcome,
        ...details,
      });

      if (runtimeState.auditEvents.length > MAX_AUDIT_EVENTS) {
        runtimeState.auditEvents.length = MAX_AUDIT_EVENTS;
      }

      runBackground(persistAudit());
    }

    async function clearErrorMetrics() {
      runtimeState.metrics.errors = getDefaultMetrics().errors;
      await persistMetrics();
    }

    async function deleteAuditEventById(eventId) {
      if (!eventId) return false;

      const beforeCount = runtimeState.auditEvents.length;
      runtimeState.auditEvents = runtimeState.auditEvents.filter(
        (event) => event?.id !== eventId,
      );

      if (runtimeState.auditEvents.length === beforeCount) {
        return false;
      }

      await persistAudit();
      return true;
    }

    function errorResponse(
      status,
      code,
      message,
      details = {},
      headers = {},
      track = true,
    ) {
      if (track) countError(code);
      return jsonResponse(
        {
          ok: false,
          error: code,
          code,
          message,
          ...details,
        },
        status,
        headers,
      );
    }

    function getRequestIp(req) {
      return (
        req.headers.get("CF-Connecting-IP") ||
        req.headers.get("X-Forwarded-For") ||
        "unknown"
      )
        .split(",")[0]
        .trim();
    }

    async function consumeRateLimit({
      prefix,
      key,
      windowMs,
      maxRequests,
    }) {
      const now = Date.now();

      if (kv) {
        const kvKey = `${prefix}${key}`;
        const existing = await readKvJson(kvKey, null);

        if (!existing || Number(existing.resetAt) <= now) {
          const next = {
            count: 1,
            resetAt: now + windowMs,
          };
          await writeKvJson(kvKey, next, {
            expirationTtl: Math.ceil(windowMs / 1000) + 60,
          });
          return {
            allowed: true,
            remaining: maxRequests - next.count,
            resetAt: next.resetAt,
          };
        }

        const next = {
          count: Number(existing.count || 0) + 1,
          resetAt: Number(existing.resetAt),
        };
        await writeKvJson(kvKey, next, {
          expirationTtl: Math.max(
            60,
            Math.ceil((next.resetAt - now) / 1000) + 60,
          ),
        });

        return {
          allowed: next.count <= maxRequests,
          remaining: Math.max(0, maxRequests - next.count),
          resetAt: next.resetAt,
        };
      }

      for (const [key, value] of runtimeState.rateLimits.entries()) {
        if (value.resetAt <= now) {
          runtimeState.rateLimits.delete(key);
        }
      }

      const memoryKey = `${prefix}${key}`;
      const existing = runtimeState.rateLimits.get(memoryKey);

      if (!existing || existing.resetAt <= now) {
        const next = {
          count: 1,
          resetAt: now + windowMs,
        };
        runtimeState.rateLimits.set(memoryKey, next);
        return {
          allowed: true,
          remaining: maxRequests - next.count,
          resetAt: next.resetAt,
        };
      }

      existing.count += 1;
      runtimeState.rateLimits.set(memoryKey, existing);

      return {
        allowed: existing.count <= maxRequests,
        remaining: Math.max(0, maxRequests - existing.count),
        resetAt: existing.resetAt,
      };
    }

    async function consumeJoinRateLimit(ip) {
      return consumeRateLimit({
        prefix: KV_JOIN_RATE_LIMIT_PREFIX,
        key: ip,
        windowMs: JOIN_RATE_LIMIT_WINDOW_MS,
        maxRequests: JOIN_RATE_LIMIT_MAX_REQUESTS,
      });
    }

    async function consumeRsvpRateLimit(ip) {
      return consumeRateLimit({
        prefix: KV_RSVP_RATE_LIMIT_PREFIX,
        key: ip,
        windowMs: RSVP_RATE_LIMIT_WINDOW_MS,
        maxRequests: RSVP_RATE_LIMIT_MAX_REQUESTS,
      });
    }

    function percent(success, failure) {
      const total = success + failure;
      if (!total) return 0;
      return Number(((success / total) * 100).toFixed(1));
    }

    function getMetricsSnapshot() {
      pruneAuditEvents();

      return {
        startedAt: runtimeState.startedAt,
        uptimeSeconds: Math.floor(
          (Date.now() - Date.parse(runtimeState.startedAt)) / 1000,
        ),
        auth: {
          ...runtimeState.metrics.auth,
          attempts:
            runtimeState.metrics.auth.success + runtimeState.metrics.auth.failure,
          successRate: percent(
            runtimeState.metrics.auth.success,
            runtimeState.metrics.auth.failure,
          ),
        },
        join: {
          ...runtimeState.metrics.join,
          attempts:
            runtimeState.metrics.join.success + runtimeState.metrics.join.failure,
          successRate: percent(
            runtimeState.metrics.join.success,
            runtimeState.metrics.join.failure,
          ),
          rateLimit: {
            windowMs: JOIN_RATE_LIMIT_WINDOW_MS,
            maxRequests: JOIN_RATE_LIMIT_MAX_REQUESTS,
          },
        },
        rsvp: {
          ...runtimeState.metrics.rsvp,
          attempts:
            runtimeState.metrics.rsvp.success + runtimeState.metrics.rsvp.failure,
          successRate: percent(
            runtimeState.metrics.rsvp.success,
            runtimeState.metrics.rsvp.failure,
          ),
          rateLimit: {
            windowMs: RSVP_RATE_LIMIT_WINDOW_MS,
            maxRequests: RSVP_RATE_LIMIT_MAX_REQUESTS,
          },
        },
        errors: runtimeState.metrics.errors,
        audit: {
          retainedEvents: runtimeState.auditEvents.length,
          maxEvents: MAX_AUDIT_EVENTS,
          retentionDays: AUDIT_RETENTION_DAYS,
        },
      };
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: isAllowedOrigin
          ? {
              "Access-Control-Allow-Origin": requestOrigin,
              ...corsHeaders,
            }
          : {},
      });
    }

    await hydratePersistentState();

    function parseCookies(req) {
      const cookieHeader = req.headers.get("Cookie") || "";
      const cookies = {};

      for (const part of cookieHeader.split(";")) {
        const item = part.trim();
        if (!item) continue;

        const index = item.indexOf("=");
        const key = index >= 0 ? item.slice(0, index) : item;
        const value = index >= 0 ? item.slice(index + 1) : "";
        cookies[key] = decodeURIComponent(value);
      }

      return cookies;
    }

    function serializeCookie(name, value, maxAge, { httpOnly = true } = {}) {
      return [
        `${name}=${encodeURIComponent(value)}`,
        "Path=/",
        `Max-Age=${maxAge}`,
        "SameSite=None",
        "Secure",
        httpOnly ? "HttpOnly" : "",
      ]
        .filter(Boolean)
        .join("; ");
    }

    function getRedirectUri() {
      return `${url.origin}/auth/callback`;
    }

    function randomState() {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function hcTokenExchange(body) {
      try {
        const response = await fetch(`${HC_AUTH_BASE}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        return data;
      } catch (err) {
        return {
          ok: false,
          error: err.message || "network_or_parse_error",
        };
      }
    }

    async function hcMe(accessToken) {
      try {
        const response = await fetch(`${HC_AUTH_BASE}/api/v1/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await response.json();
        return { ok: response.ok, status: response.status, data };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          data: {},
          error: err.message || "network_or_parse_error",
        };
      }
    }

    function getPathValue(source, path) {
      let current = source;

      for (const segment of path) {
        if (current == null) return "";
        current = current[segment];
      }

      if (typeof current === "string") return current.trim();
      if (typeof current === "number") return String(current);
      if (typeof current === "boolean") return current ? "true" : "false";
      return "";
    }

    function pickFirstValue(sources, paths, fallback = "") {
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;

        for (const path of paths) {
          const value = getPathValue(source, path);
          if (value) return value;
        }
      }

      return fallback;
    }

    function findValueAnywhere(source, keys, seen = new WeakSet()) {
      if (!source || typeof source !== "object") return "";
      if (seen.has(source)) return "";
      seen.add(source);

      if (Array.isArray(source)) {
        for (const item of source) {
          const nested = findValueAnywhere(item, keys, seen);
          if (nested) return nested;
        }
        return "";
      }

      for (const key of Object.keys(source)) {
        const value = source[key];

        if (keys.includes(key)) {
          if (typeof value === "string" && value.trim()) return value.trim();
          if (typeof value === "number") return String(value);
          if (typeof value === "boolean") return value ? "true" : "false";
        }

        if (value && typeof value === "object") {
          const nested = findValueAnywhere(value, keys, seen);
          if (nested) return nested;
        }
      }

      return "";
    }

    function normalizeSlackId(value) {
      return String(value || "")
        .trim()
        .toUpperCase();
    }

    function normalizeVerificationStatus(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, " ");
    }

    function getVerificationState(rawStatus) {
      const normalized = normalizeVerificationStatus(rawStatus);

      if (!normalized) {
        return {
          verificationStatus: "",
          verificationLabel: "Verification unknown",
          isVerified: null,
        };
      }

      if (
        normalized.includes("unverified") ||
        normalized.includes("not verified") ||
        normalized.includes("rejected") ||
        normalized.includes("failed")
      ) {
        return {
          verificationStatus: normalized,
          verificationLabel: "Not verified",
          isVerified: false,
        };
      }

      if (
        normalized.includes("pending") ||
        normalized.includes("review") ||
        normalized.includes("submitted")
      ) {
        return {
          verificationStatus: normalized,
          verificationLabel: "Verification pending",
          isVerified: false,
        };
      }

      if (normalized.includes("verified")) {
        return {
          verificationStatus: normalized,
          verificationLabel: "Verified",
          isVerified: true,
        };
      }

      return {
        verificationStatus: normalized,
        verificationLabel: String(rawStatus || "").trim() || normalized,
        isVerified: null,
      };
    }

    function normalizeYswsEligible(value) {
      if (typeof value === "boolean") return value;

      const normalized = String(value || "")
        .trim()
        .toLowerCase();

      if (["true", "yes", "eligible", "1"].includes(normalized)) {
        return true;
      }

      if (["false", "no", "ineligible", "0"].includes(normalized)) {
        return false;
      }

      return null;
    }

    function parseHCProfile(rawProfile, cookies = {}) {
      const sources = [
        rawProfile,
        rawProfile?.me,
        rawProfile?.user,
        rawProfile?.profile,
        rawProfile?.attributes,
        rawProfile?.claims,
        rawProfile?.data,
        rawProfile?.data?.user,
        rawProfile?.data?.profile,
        rawProfile?.data?.attributes,
        rawProfile?.data?.claims,
        rawProfile?.result,
        rawProfile?.result?.user,
        rawProfile?.result?.profile,
        rawProfile?.result?.attributes,
        rawProfile?.result?.claims,
      ].filter(Boolean);

      const find = (keys) => findValueAnywhere(sources, keys);
      const pick = (paths, fallback = "") =>
        pickFirstValue(sources, paths, fallback);

      const fallbackSlackId = find([
        "slack_id",
        "slackId",
        "slack_user_id",
        "slackUserId",
      ]);

      const fallbackUsername = find([
        "username",
        "preferred_username",
        "nickname",
        "display_name",
      ]);

      const fallbackName = find([
        "name",
        "full_name",
        "preferred_name",
        "display_name",
      ]);

      const fallbackEmail = find(["email", "primary_email"]);

      const fallbackAvatar = find([
        "picture",
        "picture_url",
        "avatar",
        "avatar_url",
        "image",
        "image_url",
        "profile_image_url",
      ]);

      const fallbackVerificationStatus = find([
        "verification_status",
        "verificationStatus",
      ]);

      const fallbackYswsEligible = find(["ysws_eligible", "yswsEligible"]);

      const slackId = normalizeSlackId(
        pick(
          [
            ["slack_id"],
            ["slackId"],
            ["slack_user_id"],
            ["slackUserId"],
            ["slack", "id"],
            ["slack", "user_id"],
            ["slack", "slack_id"],
          ],
          fallbackSlackId || cookies.hcSlackId || "",
        ),
      );

      const username = pick(
        [
          ["username"],
          ["preferred_username"],
          ["display_name"],
          ["nickname"],
          ["name"],
        ],
        fallbackUsername || cookies.hcName || "",
      );

      const name = pick(
        [
          ["name"],
          ["full_name"],
          ["display_name"],
          ["preferred_name"],
          ["username"],
        ],
        fallbackName || username || cookies.hcName || "Hacker",
      );

      const email = pick(
        [["email"], ["primary_email"], ["emails", 0, "email"], ["emails", 0]],
        fallbackEmail || cookies.hcEmail || "",
      );

      const avatar = pick(
        [
          ["picture"],
          ["picture_url"],
          ["avatar"],
          ["avatar_url"],
          ["image"],
          ["image_url"],
          ["profile_image_url"],
        ],
        fallbackAvatar || cookies.hcAvatar || "",
      );

      const verificationStatus = pick(
        [
          ["verification_status"],
          ["verificationStatus"],
          ["status", "verification"],
        ],
        fallbackVerificationStatus || "",
      );

      const yswsEligible = normalizeYswsEligible(
        pick([["ysws_eligible"], ["yswsEligible"]], fallbackYswsEligible || ""),
      );

      return {
        slackId,
        username,
        name,
        email,
        avatar,
        yswsEligible,
        ...getVerificationState(verificationStatus),
      };
    }

    async function slackGet(path, params = {}, envRef) {
      const q = new URLSearchParams(params);
      const response = await fetch(
        `https://slack.com/api/${path}?${q.toString()}`,
        {
          headers: { Authorization: `Bearer ${envRef.SLACK_TOKEN}` },
        },
      );
      return response.json();
    }

    async function isUserInChannel(channelId, userId) {
      let cursor = "";
      for (let i = 0; i < 20; i++) {
        const data = await slackGet(
          "conversations.members",
          {
            channel: channelId,
            limit: "1000",
            ...(cursor ? { cursor } : {}),
          },
          env,
        );

        if (!data.ok) return false;
        if ((data.members || []).includes(userId)) return true;

        cursor = data.response_metadata?.next_cursor || "";
        if (!cursor) break;
      }
      return false;
    }

    async function getSessionProfile(req) {
      const cookies = parseCookies(req);
      const accessToken = (cookies.hcAccessToken || "").trim();

      if (!accessToken) {
        return {
          ok: false,
          status: 401,
          code: "not_authenticated",
          message: "Sign in with HC Auth to continue.",
          cookies,
        };
      }

      const me = await hcMe(accessToken);
      if (!me.ok) {
        return {
          ok: false,
          status: 401,
          code: "auth_expired",
          message: "Your session expired. Please sign in again.",
          cookies,
        };
      }

      return {
        ok: true,
        cookies,
        accessToken,
        me,
        profile: parseHCProfile(me.data || {}, cookies),
      };
    }

    async function requireAdmin(req, { logDenied = true } = {}) {
      const session = await getSessionProfile(req);

      if (!session.ok) {
        return {
          ok: false,
          response: errorResponse(
            session.status,
            session.code,
            session.message,
            {},
            {},
            false,
          ),
        };
      }

      const adminSlackId = normalizeSlackId(
        session.profile.slackId || session.cookies.hcSlackId,
      );

      if (adminSlackId !== ADMIN_SLACK_ID) {
        if (logDenied) {
          recordEvent("admin_access", "failure", {
            slackId: adminSlackId || "unknown",
            ip: getRequestIp(req),
            code: "admin_only",
          });
        }
        return {
          ok: false,
          response: errorResponse(
            403,
            "admin_only",
            "Only the configured admin can access this endpoint.",
          ),
        };
      }

      return {
        ok: true,
        session,
        slackId: adminSlackId,
      };
    }

    switch (url.pathname) {
      case "/auth/start": {
        if (!env.HC_CLIENT_ID) {
          return new Response("Missing HC_CLIENT_ID", { status: 500 });
        }

        const state = randomState();
        const authUrl = new URL(`${HC_AUTH_BASE}/oauth/authorize`);
        authUrl.searchParams.set("client_id", env.HC_CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", getRedirectUri());
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", HC_OAUTH_SCOPE);
        authUrl.searchParams.set("state", state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: authUrl.toString(),
            "Set-Cookie": serializeCookie("hcOauthState", state, 600),
          },
        });
      }

      case "/auth/callback": {
        const cookies = parseCookies(request);
        const code = (url.searchParams.get("code") || "").trim();
        const state = (url.searchParams.get("state") || "").trim();
        const ip = getRequestIp(request);

        if (!code || !state || state !== cookies.hcOauthState) {
          recordMetric("auth", "failure");
          countError("oauth_state_invalid");
          recordEvent("auth_callback", "failure", {
            code: "oauth_state_invalid",
          });
          const target = allowedOrigin || "/";
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${target}?oauth_error=${encodeURIComponent("Hack Club Auth verification failed")}`,
              "Set-Cookie": serializeCookie("hcOauthState", "", 0),
            },
          });
        }

        const tokenData = await hcTokenExchange({
          client_id: env.HC_CLIENT_ID,
          client_secret: env.HC_CLIENT_SECRET,
          redirect_uri: getRedirectUri(),
          code,
          grant_type: "authorization_code",
        });

        if (!tokenData.access_token) {
          recordMetric("auth", "failure");
          countError("oauth_token_exchange_failed");
          recordEvent("auth_callback", "failure", {
            code: "oauth_token_exchange_failed",
            details: tokenData.error || "token_exchange_failed",
          });
          const target = allowedOrigin || "/";
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${target}?oauth_error=${encodeURIComponent(tokenData.error || "Token exchange failed")}`,
              "Set-Cookie": serializeCookie("hcOauthState", "", 0),
            },
          });
        }

        const me = await hcMe(tokenData.access_token);
        if (!me.ok) {
          recordMetric("auth", "failure");
          countError("hc_profile_fetch_failed");
          recordEvent("auth_callback", "failure", {
            code: "hc_profile_fetch_failed",
            status: me.status,
          });
          const target = allowedOrigin || "/";
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${target}?oauth_error=${encodeURIComponent("Could not load your Hack Club profile")}`,
              "Set-Cookie": serializeCookie("hcOauthState", "", 0),
            },
          });
        }

        const profile = parseHCProfile(me.data || {});
        recordMetric("auth", "success");
        recordEvent("auth_callback", "success", {
          slackId: profile.slackId || "unknown",
        });

        const headers = new Headers({ Location: allowedOrigin || "/" });
        headers.append("Set-Cookie", serializeCookie("hcOauthState", "", 0));
        headers.append(
          "Set-Cookie",
          serializeCookie("hcAccessToken", tokenData.access_token, 15552000),
        );
        headers.append(
          "Set-Cookie",
          serializeCookie(
            "hcRefreshToken",
            tokenData.refresh_token || "",
            31536000,
          ),
        );
        headers.append(
          "Set-Cookie",
          serializeCookie("hcSlackId", profile.slackId, 31536000),
        );
        headers.append(
          "Set-Cookie",
          serializeCookie("hcName", profile.name, 31536000, { httpOnly: false }),
        );
        headers.append(
          "Set-Cookie",
          serializeCookie("hcEmail", profile.email, 31536000, {
            httpOnly: false,
          }),
        );
        headers.append(
          "Set-Cookie",
          serializeCookie("hcAvatar", profile.avatar, 31536000, {
            httpOnly: false,
          }),
        );

        return new Response(null, { status: 302, headers });
      }

      case "/auth/logout": {
        const headers = new Headers({ Location: allowedOrigin || "/" });
        [
          "hcAccessToken",
          "hcRefreshToken",
          "hcSlackId",
          "hcName",
          "hcEmail",
          "hcAvatar",
          "hcOauthState",
        ].forEach((key) => {
          headers.append(
            "Set-Cookie",
            serializeCookie(key, "", 0, {
              httpOnly: !PUBLIC_COOKIE_KEYS.includes(key),
            }),
          );
        });
        return new Response(null, { status: 302, headers });
      }

      case "/ysws.json":
        return withCors(Response.json(YSWS_LIST));

      case "/api/user": {
        const session = await getSessionProfile(request);
        if (!session.ok) {
          return jsonResponse(
            { ok: false, error: session.code, code: session.code },
            session.status,
          );
        }

        const fallbackSlackId = (session.cookies.hcSlackId || "")
          .trim()
          .toUpperCase();
        const profile = session.profile;
        const slackId = normalizeSlackId(profile.slackId || fallbackSlackId);
        let slackUser = null;

        if (slackId && env.SLACK_TOKEN) {
          const slackUserData = await slackGet(
            "users.info",
            { user: slackId },
            env,
          );
          if (slackUserData?.ok && slackUserData.user) {
            slackUser = slackUserData.user;
          }
        }

        const slackUsername = String(slackUser?.name || "").trim();
        const slackName = String(
          slackUser?.profile?.real_name ||
            slackUser?.profile?.display_name ||
            slackUser?.real_name ||
            "",
        ).trim();
        const slackAvatar = String(
          slackUser?.profile?.image_192 ||
            slackUser?.profile?.image_72 ||
            slackUser?.profile?.image_48 ||
            "",
        ).trim();
        const slackEmail = String(slackUser?.profile?.email || "").trim();

        const membership = {};
        if (slackId && env.SLACK_TOKEN) {
          await Promise.all(
            YSWS_LIST.map(async (p) => {
              membership[p.channel] = await isUserInChannel(p.channel, slackId);
            }),
          );
        } else {
          for (const p of YSWS_LIST) membership[p.channel] = false;
        }

        const rsvpDone = await readUserRsvpDone(slackId);

        return withCors(
          Response.json({
            ok: true,
            slackId,
            username: slackUsername || profile.username,
            name: slackName || profile.name,
            avatar: slackAvatar || profile.avatar,
            email: slackEmail || profile.email,
            membership,
            rsvpDone,
            verificationStatus: profile.verificationStatus,
            verificationLabel: profile.verificationLabel,
            isVerified: profile.isVerified,
            yswsEligible: profile.yswsEligible,
          }),
        );
      }

      case "/api/rsvp": {
        if (request.method !== "POST") break;

        const ip = getRequestIp(request);
        const rateLimit = await consumeRsvpRateLimit(ip);
        const rateLimitHeaders = {
          "X-RateLimit-Limit": String(RSVP_RATE_LIMIT_MAX_REQUESTS),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.resetAt),
        };

        if (!rateLimit.allowed) {
          recordMetric("rsvp", "failure");
          recordEvent("rsvp_done", "failure", {
            code: "rate_limited",
            ip,
          });
          return errorResponse(
            429,
            "rate_limited",
            "Too many RSVP updates from this IP. Please wait a few minutes.",
            {
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
              ),
            },
            {
              ...rateLimitHeaders,
              "Retry-After": String(
                Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
              ),
            },
          );
        }

        const session = await getSessionProfile(request);
        if (!session.ok) {
          recordMetric("rsvp", "failure");
          return errorResponse(
            session.status,
            session.code,
            session.message,
            {},
            rateLimitHeaders,
            false,
          );
        }

        if (!kv) {
          recordMetric("rsvp", "failure");
          return errorResponse(
            500,
            "missing_storage",
            "RSVP completion storage is not configured.",
            {},
            rateLimitHeaders,
          );
        }

        const body = await request.json().catch(() => null);
        const channel = normalizeSlackId(body?.channel || "");
        const done = body?.done !== false;

        if (!channel) {
          recordMetric("rsvp", "failure");
          recordEvent("rsvp_done", "failure", {
            code: "invalid_payload",
            ip,
          });
          return errorResponse(
            400,
            "invalid_payload",
            "RSVP updates must include a valid channel ID.",
            {},
            rateLimitHeaders,
          );
        }

        if (!allowedChannels.has(channel)) {
          recordMetric("rsvp", "failure");
          recordEvent("rsvp_done", "failure", {
            channel,
            code: "channel_not_allowed",
            ip,
          });
          return errorResponse(
            403,
            "channel_not_allowed",
            "That channel isn't on the allowed list.",
            { channel },
            rateLimitHeaders,
          );
        }

        const slackId = normalizeSlackId(
          session.profile.slackId || session.cookies.hcSlackId,
        );

        if (!slackId) {
          recordMetric("rsvp", "failure");
          recordEvent("rsvp_done", "failure", {
            channel,
            code: "missing_slack_id",
            ip,
          });
          return errorResponse(
            400,
            "missing_slack_id",
            "Your account is missing the Slack scope. Sign out and back in.",
            {},
            rateLimitHeaders,
          );
        }

        const currentState = await readUserRsvpDone(slackId);
        currentState[channel] = done;
        const rsvpDone = await writeUserRsvpDone(slackId, currentState);

        recordMetric("rsvp", "success");
        recordEvent("rsvp_done", "success", {
          slackId,
          channel,
          done,
        });

        return jsonResponse({
          ok: true,
          slackId,
          channel,
          done,
          rsvpDone,
        }, 200, rateLimitHeaders);
      }

      case "/api/join": {
        if (request.method !== "POST") break;

        const ip = getRequestIp(request);
        const rateLimit = await consumeJoinRateLimit(ip);
        const rateLimitHeaders = {
          "X-RateLimit-Limit": String(JOIN_RATE_LIMIT_MAX_REQUESTS),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.resetAt),
        };

        if (!rateLimit.allowed) {
          recordMetric("join", "failure");
          recordEvent("join", "failure", {
            code: "rate_limited",
          });
          return errorResponse(
            429,
            "rate_limited",
            "Too many join requests from this IP. Please wait a few minutes.",
            {
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
              ),
            },
            {
              ...rateLimitHeaders,
              "Retry-After": String(
                Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
              ),
            },
          );
        }

        const session = await getSessionProfile(request);
        if (!session.ok) {
          recordMetric("join", "failure");
          recordEvent("join", "failure", {
            code: session.code,
          });
          return errorResponse(
            session.status,
            session.code,
            session.message,
            {},
            rateLimitHeaders,
            false,
          );
        }

        if (!env.SLACK_TOKEN) {
          recordMetric("join", "failure");
          recordEvent("join", "failure", {
            code: "missing_slack_token",
          });
          return errorResponse(
            500,
            "missing_slack_token",
            "Slack isn't set up. Contact the site owner.",
            {},
            rateLimitHeaders,
          );
        }

        const data = await request.json().catch(() => null);
        const channel = normalizeSlackId(data?.channel || "");

        if (!channel) {
          recordMetric("join", "failure");
          recordEvent("join", "failure", {
            code: "invalid_payload",
          });
          return errorResponse(
            400,
            "invalid_payload",
            "Join requests must include a valid channel ID.",
            {},
            rateLimitHeaders,
          );
        }

        if (!allowedChannels.has(channel)) {
          recordMetric("join", "failure");
          recordEvent("join", "failure", {
            channel,
            code: "channel_not_allowed",
          });
          return errorResponse(
            403,
            "channel_not_allowed",
            "That channel isn't on the allowed list.",
            { channel },
            rateLimitHeaders,
          );
        }

        const profile = session.profile;
        const slackId = normalizeSlackId(
          profile.slackId || session.cookies.hcSlackId,
        );

        if (!slackId) {
          recordMetric("join", "failure");
          recordEvent("join", "failure", {
            channel,
            code: "missing_slack_id",
          });
          return errorResponse(
            400,
            "missing_slack_id",
            "Your account is missing the Slack scope. Sign out and back in.",
            {},
            rateLimitHeaders,
          );
        }

        const invite = await fetch(
          "https://slack.com/api/conversations.invite",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.SLACK_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ channel, users: slackId }),
          },
        );

        const inviteData = await invite
          .json()
          .catch(() => ({ ok: false, error: "invite_failed" }));
        if (!inviteData.ok && inviteData.error !== "already_in_channel") {
          recordMetric("join", "failure");
          recordEvent("join", "failure", {
            channel,
            slackId,
            code: inviteData.error || "invite_failed",
          });
          return errorResponse(
            400,
            inviteData.error || "invite_failed",
            "Could not add you to that Slack channel.",
            { channel },
            rateLimitHeaders,
          );
        }

        recordMetric("join", "success");
        recordEvent("join", "success", {
          channel,
          slackId,
          result: inviteData.error === "already_in_channel" ? "already_in_channel" : "invited",
        });

        return jsonResponse({ ok: true }, 200, rateLimitHeaders);
      }

      case "/api/admin/metrics": {
        const admin = await requireAdmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        return jsonResponse({
          ok: true,
          adminSlackId: admin.slackId,
          metrics: getMetricsSnapshot(),
        });
      }

      case "/api/admin/access": {
        const admin = await requireAdmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        return jsonResponse({
          ok: true,
          adminSlackId: admin.slackId,
        });
      }

      case "/api/admin/audit": {
        const admin = await requireAdmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        if (request.method === "DELETE") {
          const eventId = String(url.searchParams.get("id") || "").trim();

          if (eventId) {
            const deleted = await deleteAuditEventById(eventId);
            if (!deleted) {
              return errorResponse(
                404,
                "audit_event_not_found",
                "That audit event could not be found.",
              );
            }

            return jsonResponse({
              ok: true,
              adminSlackId: admin.slackId,
              deletedId: eventId,
            });
          }

          const clearedCount = runtimeState.auditEvents.length;
          runtimeState.auditEvents = [];
          await persistAudit();

          return jsonResponse({
            ok: true,
            adminSlackId: admin.slackId,
            clearedCount,
          });
        }

        if (request.method !== "GET") {
          return errorResponse(
            405,
            "method_not_allowed",
            "Only GET and DELETE are supported for admin audit.",
          );
        }

        const limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit") || 25)),
        );
        const prunedCount = pruneAuditEvents();

        return jsonResponse({
          ok: true,
          adminSlackId: admin.slackId,
          retentionDays: AUDIT_RETENTION_DAYS,
          prunedCount,
          events: runtimeState.auditEvents.slice(0, limit),
        });
      }

      case "/api/admin/errors": {
        const admin = await requireAdmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        if (request.method !== "DELETE") {
          return errorResponse(
            405,
            "method_not_allowed",
            "Only DELETE is supported for admin errors.",
          );
        }

        const clearedTotal = runtimeState.metrics.errors.total || 0;
        await clearErrorMetrics();

        return jsonResponse({
          ok: true,
          adminSlackId: admin.slackId,
          clearedTotal,
        });
      }

      case "/api/admin/view-as": {
        if (request.method !== "GET") break;

        const admin = await requireAdmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        const targetId = normalizeSlackId(url.searchParams.get("slackId") || "");
        if (!targetId) {
          return errorResponse(400, "missing_slack_id", "Provide a slackId query param.");
        }

        let slackUser = null;
        if (env.SLACK_TOKEN) {
          const slackUserData = await slackGet("users.info", { user: targetId }, env);
          if (slackUserData?.ok && slackUserData.user) {
            slackUser = slackUserData.user;
          }
        }

        if (!slackUser) {
          return errorResponse(404, "user_not_found", "Could not find a Slack user with that ID.");
        }

        const membership = {};
        if (env.SLACK_TOKEN) {
          await Promise.all(
            YSWS_LIST.map(async (p) => {
              membership[p.channel] = await isUserInChannel(p.channel, targetId);
            }),
          );
        } else {
          for (const p of YSWS_LIST) membership[p.channel] = false;
        }

        const rsvpDone = await readUserRsvpDone(targetId);

        const profile = {
          slackId: targetId,
          username: slackUser.name || "",
          name: slackUser.profile?.real_name || slackUser.profile?.display_name || "",
          avatar: slackUser.profile?.image_192 || slackUser.profile?.image_72 || "",
          email: slackUser.profile?.email || "",
          verificationStatus: "",
          verificationLabel: "Not available",
          isVerified: null,
          yswsEligible: null,
        };

        return jsonResponse({
          ok: true,
          ...profile,
          membership,
          rsvpDone,
        });
      }

      case "/api/admin/lookup": {
        if (request.method !== "GET") break;

        const admin = await requireAdmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        const targetId = normalizeSlackId(url.searchParams.get("slackId") || "");
        if (!targetId) {
          return errorResponse(400, "missing_slack_id", "Provide a slackId query param.");
        }

        let slackUser = null;
        if (env.SLACK_TOKEN) {
          const slackUserData = await slackGet("users.info", { user: targetId }, env);
          if (slackUserData?.ok && slackUserData.user) {
            slackUser = slackUserData.user;
          }
        }

        const membership = {};
        if (env.SLACK_TOKEN) {
          await Promise.all(
            YSWS_LIST.map(async (p) => {
              membership[p.channel] = await isUserInChannel(p.channel, targetId);
            }),
          );
        } else {
          for (const p of YSWS_LIST) membership[p.channel] = false;
        }

        const rsvpDone = await readUserRsvpDone(targetId);

        return jsonResponse({
          ok: true,
          slackId: targetId,
          name: slackUser?.profile?.real_name || slackUser?.profile?.display_name || "",
          username: slackUser?.name || "",
          avatar: slackUser?.profile?.image_192 || slackUser?.profile?.image_72 || "",
          membership,
          rsvpDone,
        });
      }

      case "/api/admin/test-join": {
        if (request.method !== "POST") break;

        const admin = await requireAdmin(request);
        if (!admin.ok) return admin.response;

        if (!env.SLACK_TOKEN) {
          return errorResponse(500, "missing_slack_token", "Slack isn't set up. Contact the site owner.");
        }

        const body = await request.json().catch(() => null);
        const channel = normalizeSlackId(body?.channel || "");
        const targetId = normalizeSlackId(body?.slackId || "");

        if (!channel || !targetId) {
          return errorResponse(400, "invalid_payload", "Provide channel and slackId.");
        }

        if (!allowedChannels.has(channel)) {
          return errorResponse(403, "channel_not_allowed", "That channel isn't on the allowed list.", { channel });
        }

        const invite = await fetch("https://slack.com/api/conversations.invite", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.SLACK_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel, users: targetId }),
        });

        const inviteData = await invite.json().catch(() => ({ ok: false, error: "invite_failed" }));

        recordEvent("admin_test_join", inviteData.ok || inviteData.error === "already_in_channel" ? "success" : "failure", {
          adminSlackId: admin.slackId,
          channel,
          slackId: targetId,
          result: inviteData.error || "invited",
        });

        if (!inviteData.ok && inviteData.error !== "already_in_channel") {
          return errorResponse(400, inviteData.error || "invite_failed", "Could not add that user to the channel.", { channel });
        }

        return jsonResponse({
          ok: true,
          channel,
          slackId: targetId,
          result: inviteData.error === "already_in_channel" ? "already_in_channel" : "invited",
        });
      }

      case "/api/admin/test-rsvp": {
        if (request.method !== "POST") break;

        const admin = await requireAdmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        if (!kv) {
          return errorResponse(500, "missing_storage", "RSVP completion storage is not configured.");
        }

        const body = await request.json().catch(() => null);
        const channel = normalizeSlackId(body?.channel || "");
        const targetId = normalizeSlackId(body?.slackId || "");
        const done = body?.done !== false;

        if (!channel || !targetId) {
          return errorResponse(400, "invalid_payload", "Provide channel and slackId.");
        }

        if (!allowedChannels.has(channel)) {
          return errorResponse(403, "channel_not_allowed", "That channel isn't on the allowed list.", { channel });
        }

        const currentState = await readUserRsvpDone(targetId);
        currentState[channel] = done;
        const rsvpDone = await writeUserRsvpDone(targetId, currentState);

        recordEvent("admin_test_rsvp", "success", {
          adminSlackId: admin.slackId,
          channel,
          slackId: targetId,
          done,
        });

        return jsonResponse({
          ok: true,
          channel,
          slackId: targetId,
          done,
          rsvpDone,
        });
      }

      case "/health":
        return withCors(Response.json({ ok: true, service: "ysws-rsvp-hca" }));
    }

    return withCors(new Response("Not found", { status: 404 }));
  },
};
