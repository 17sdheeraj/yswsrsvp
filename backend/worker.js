import YSWS_LIST from "./public/ysws.json";

const hcauthbase = "https://auth.hackclub.com";
const hcoauthscope = "openid profile email name slack_id verification_status";
const publiccookiekeys = ["hcName", "hcEmail", "hcAvatar"];
const adminslackid = "U0828RTU7FE";
const maxauditevents = 100;
const auditretentiondays = 14;
const auditretentionms = auditretentiondays * 24 * 60 * 60 * 1000;
const joinratelimitwindowms = 5 * 60 * 1000;
const joinratelimitmaxrequests = 8;
const rsvpratelimitwindowms = 5 * 60 * 1000;
const rsvpratelimitmaxrequests = 12;
const kvmetricskey = "ops:metrics:v1";
const kvauditkey = "ops:audit:v1";
const kvjoinratelimitprefix = "ops:rate-limit:join:";
const kvrsvpratelimitprefix = "ops:rate-limit:rsvp:";
const kvrsvpdoneprefix = "ops:rsvp:done:";
const kvsessionprefix = "ops:session:v1:";
const sessiontokenttlseconds = 60 * 60 * 12;
const sessiontokenmaxagems = sessiontokenttlseconds * 1000;

function getruntimestate() {
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
    const primaryFrontendOrigin = allowedOrigins[0] || "";
    const isAllowedOrigin =
      requestOrigin && allowedOrigins.includes(requestOrigin);
    const runtimeState = getruntimestate();
    const kv = env.YSWS && typeof env.YSWS.get === "function" ? env.YSWS : null;
    const allowedChannels = new Set(
      YSWS_LIST.map((item) => String(item.channel || "").trim().toUpperCase()),
    );

    const corsHeaders = {
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

    function jsonresponse(body, status = 200, headers = {}) {
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

    function getdefaultmetrics() {
      return {
        auth: { success: 0, failure: 0 },
        join: { success: 0, failure: 0 },
        rsvp: { success: 0, failure: 0 },
        errors: { total: 0, byCode: {} },
      };
    }

    async function readkvjson(key, fallback) {
      if (!kv) return fallback;

      try {
        const value = await kv.get(key, "json");
        return value ?? fallback;
      } catch {
        return fallback;
      }
    }

    async function writekvjson(key, value, options = {}) {
      if (!kv) return;

      try {
        await kv.put(key, JSON.stringify(value), options);
      } catch {
      }
    }

    function parsebearersessiontoken(req) {
      const authHeader = String(req.headers.get("Authorization") || "").trim();
      if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
      return authHeader.slice(7).trim();
    }

    function getsessionfingerprint(req) {
      const userAgent = String(req.headers.get("User-Agent") || "")
        .trim()
        .toLowerCase()
        .slice(0, 180);
      const language = String(req.headers.get("Accept-Language") || "")
        .split(",")[0]
        .trim()
        .toLowerCase()
        .slice(0, 32);
      return `${userAgent}|${language}`;
    }

    function getsessionkey(token) {
      return `${kvsessionprefix}${token}`;
    }

    async function writesessiontoken(token, payload, req) {
      if (!kv || !token || !payload?.accessToken) return;
      await writekvjson(getsessionkey(token), {
        accessToken: payload.accessToken,
        slackId: normalizeslackid(payload.slackId || ""),
        fingerprint: getsessionfingerprint(req),
        issuedAt: Date.now(),
      }, {
        expirationTtl: sessiontokenttlseconds,
      });
    }

    async function deletesessiontoken(token) {
      if (!kv || !token) return;
      try {
        await kv.delete(getsessionkey(token));
      } catch {
      }
    }

    async function readsessiontoken(token, req) {
      if (!kv || !token) return null;
      const data = await readkvjson(getsessionkey(token), null);
      if (!data || typeof data !== "object") return null;
      const accessToken = String(data.accessToken || "").trim();
      if (!accessToken) return null;
      const issuedAt = Number(data.issuedAt || 0);
      const storedFingerprint = String(data.fingerprint || "");
      const currentFingerprint = getsessionfingerprint(req);
      const isExpired = !issuedAt || Date.now() - issuedAt > sessiontokenmaxagems;
      const fingerprintMismatch =
        Boolean(storedFingerprint) && storedFingerprint !== currentFingerprint;

      if (isExpired || fingerprintMismatch) {
        await deletesessiontoken(token);
        return null;
      }

      return {
        accessToken,
        slackId: normalizeslackid(data.slackId || ""),
      };
    }

    function getrsvpdonekey(slackId) {
      return `${kvrsvpdoneprefix}${slackId}`;
    }

    function normalizersvpdonestate(value) {
      const next = {};

      for (const item of YSWS_LIST) {
        const channel = String(item.channel || "").trim().toUpperCase();
        if (!channel) continue;
        next[channel] = Boolean(value?.[channel]);
      }

      return next;
    }

    async function readuserrsvpdone(slackId) {
      if (!slackId || !kv) return normalizersvpdonestate({});
      const stored = await readkvjson(getrsvpdonekey(slackId), {});
      return normalizersvpdonestate(stored || {});
    }

    async function writeuserrsvpdone(slackId, value) {
      const next = normalizersvpdonestate(value);
      if (!slackId || !kv) return next;
      await writekvjson(getrsvpdonekey(slackId), next);
      return next;
    }

    function runbackground(task) {
      if (!task) return;
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(task);
      }
    }

    async function hydratepersistentstate() {
      if (runtimeState.kvHydrated || !kv) return;

      const [storedMetrics, storedAudit] = await Promise.all([
        readkvjson(kvmetricskey, null),
        readkvjson(kvauditkey, null),
      ]);

      runtimeState.metrics = {
        ...getdefaultmetrics(),
        ...(storedMetrics || {}),
        auth: {
          ...getdefaultmetrics().auth,
          ...(storedMetrics?.auth || {}),
        },
        join: {
          ...getdefaultmetrics().join,
          ...(storedMetrics?.join || {}),
        },
        rsvp: {
          ...getdefaultmetrics().rsvp,
          ...(storedMetrics?.rsvp || {}),
        },
        errors: {
          ...getdefaultmetrics().errors,
          ...(storedMetrics?.errors || {}),
          byCode: {
            ...getdefaultmetrics().errors.byCode,
            ...(storedMetrics?.errors?.byCode || {}),
          },
        },
      };
      runtimeState.auditEvents = Array.isArray(storedAudit)
        ? storedAudit.slice(0, maxauditevents)
        : [];
      pruneauditevents();
      runtimeState.kvHydrated = true;
    }

    function persistmetrics() {
      if (!kv) return null;
      return writekvjson(kvmetricskey, runtimeState.metrics);
    }

    function persistaudit() {
      if (!kv) return null;
      return writekvjson(kvauditkey, runtimeState.auditEvents);
    }

    function pruneauditevents() {
      const cutoff = Date.now() - auditretentionms;
      const beforeCount = runtimeState.auditEvents.length;

      runtimeState.auditEvents = runtimeState.auditEvents
        .filter((event) => {
          const timestamp = Date.parse(event?.timestamp || "");
          return !Number.isNaN(timestamp) && timestamp >= cutoff;
        })
        .slice(0, maxauditevents);

      const removedCount = beforeCount - runtimeState.auditEvents.length;
      if (removedCount > 0) {
        runbackground(persistaudit());
      }

      return removedCount;
    }

    function counterror(code) {
      runtimeState.metrics.errors.total += 1;
      runtimeState.metrics.errors.byCode[code] =
        (runtimeState.metrics.errors.byCode[code] || 0) + 1;
      runbackground(persistmetrics());
    }

    function recordmetric(group, outcome) {
      if (!runtimeState.metrics[group]) return;
      runtimeState.metrics[group][outcome] += 1;
      runbackground(persistmetrics());
    }

    function recordevent(type, outcome, details = {}) {
      pruneauditevents();

      runtimeState.auditEvents.unshift({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type,
        outcome,
        ...details,
      });

      if (runtimeState.auditEvents.length > maxauditevents) {
        runtimeState.auditEvents.length = maxauditevents;
      }

      runbackground(persistaudit());
    }

    async function clearerrormetrics() {
      runtimeState.metrics.errors = getdefaultmetrics().errors;
      await persistmetrics();
    }

    async function deleteauditeventbyid(eventId) {
      if (!eventId) return false;

      const beforeCount = runtimeState.auditEvents.length;
      runtimeState.auditEvents = runtimeState.auditEvents.filter(
        (event) => event?.id !== eventId,
      );

      if (runtimeState.auditEvents.length === beforeCount) {
        return false;
      }

      await persistaudit();
      return true;
    }

    function errorresponse(
      status,
      code,
      message,
      details = {},
      headers = {},
      track = true,
    ) {
      if (track) counterror(code);
      return jsonresponse(
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

    function getrequestip(req) {
      return (
        req.headers.get("CF-Connecting-IP") ||
        req.headers.get("X-Forwarded-For") ||
        "unknown"
      )
        .split(",")[0]
        .trim();
    }

    async function consumeratelimit({
      prefix,
      key,
      windowMs,
      maxRequests,
    }) {
      const now = Date.now();

      if (kv) {
        const kvKey = `${prefix}${key}`;
        const existing = await readkvjson(kvKey, null);

        if (!existing || Number(existing.resetAt) <= now) {
          const next = {
            count: 1,
            resetAt: now + windowMs,
          };
          await writekvjson(kvKey, next, {
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
        await writekvjson(kvKey, next, {
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

    async function consumejoinratelimit(ip) {
      return consumeratelimit({
        prefix: kvjoinratelimitprefix,
        key: ip,
        windowMs: joinratelimitwindowms,
        maxRequests: joinratelimitmaxrequests,
      });
    }

    async function consumersvpratelimit(ip) {
      return consumeratelimit({
        prefix: kvrsvpratelimitprefix,
        key: ip,
        windowMs: rsvpratelimitwindowms,
        maxRequests: rsvpratelimitmaxrequests,
      });
    }

    function percent(success, failure) {
      const total = success + failure;
      if (!total) return 0;
      return Number(((success / total) * 100).toFixed(1));
    }

    function getmetricssnapshot() {
      pruneauditevents();

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
            windowMs: joinratelimitwindowms,
            maxRequests: joinratelimitmaxrequests,
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
            windowMs: rsvpratelimitwindowms,
            maxRequests: rsvpratelimitmaxrequests,
          },
        },
        errors: runtimeState.metrics.errors,
        audit: {
          retainedEvents: runtimeState.auditEvents.length,
          maxEvents: maxauditevents,
          retentionDays: auditretentiondays,
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

    await hydratepersistentstate();

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

    function getredirecturi() {
      return `${url.origin}/auth/callback`;
    }

    function buildfrontendlocation(extraParams = {}) {
      const target = primaryFrontendOrigin || "/";
      const redirectUrl = new URL(target, url.origin);

      for (const [key, value] of Object.entries(extraParams)) {
        if (value == null || value === "") continue;
        redirectUrl.searchParams.set(key, String(value));
      }

      return redirectUrl.toString();
    }

    function randomstate() {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function hctokenexchange(body) {
      try {
        const response = await fetch(`${hcauthbase}/oauth/token`, {
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

    async function hcme(accessToken) {
      try {
        const response = await fetch(`${hcauthbase}/api/v1/me`, {
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

    function getpathvalue(source, path) {
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

    function pickfirstvalue(sources, paths, fallback = "") {
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;

        for (const path of paths) {
          const value = getpathvalue(source, path);
          if (value) return value;
        }
      }

      return fallback;
    }

    function findvalueanywhere(source, keys, seen = new WeakSet()) {
      if (!source || typeof source !== "object") return "";
      if (seen.has(source)) return "";
      seen.add(source);

      if (Array.isArray(source)) {
        for (const item of source) {
          const nested = findvalueanywhere(item, keys, seen);
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
          const nested = findvalueanywhere(value, keys, seen);
          if (nested) return nested;
        }
      }

      return "";
    }

    function normalizeslackid(value) {
      return String(value || "")
        .trim()
        .toUpperCase();
    }

    function normalizeverificationstatus(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, " ");
    }

    function getverificationstate(rawStatus) {
      const normalized = normalizeverificationstatus(rawStatus);

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

    function normalizeyswseligible(value) {
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

    function parsehcprofile(rawProfile, cookies = {}) {
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

      const find = (keys) => findvalueanywhere(sources, keys);
      const pick = (paths, fallback = "") =>
        pickfirstvalue(sources, paths, fallback);

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

      const slackId = normalizeslackid(
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

      const yswsEligible = normalizeyswseligible(
        pick([["ysws_eligible"], ["yswsEligible"]], fallbackYswsEligible || ""),
      );

      return {
        slackId,
        username,
        name,
        email,
        avatar,
        yswsEligible,
        ...getverificationstate(verificationStatus),
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

    async function isuserinchannel(channelId, userId) {
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

    async function getsessionprofile(req) {
      const cookies = parseCookies(req);
      let accessToken = (cookies.hcAccessToken || "").trim();
      let fallbackSlackId = normalizeslackid(cookies.hcSlackId || "");

      if (!accessToken) {
        const bearerToken = parsebearersessiontoken(req);
        const sessionFromToken = await readsessiontoken(bearerToken, req);
        if (sessionFromToken?.accessToken) {
          accessToken = sessionFromToken.accessToken;
          fallbackSlackId = normalizeslackid(
            sessionFromToken.slackId || fallbackSlackId,
          );
        }
      }

      if (!accessToken) {
        return {
          ok: false,
          status: 401,
          code: "not_authenticated",
          message: "Sign in with HC Auth to continue.",
          cookies,
        };
      }

      const me = await hcme(accessToken);
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
        profile: parsehcprofile(me.data || {}, {
          ...cookies,
          hcSlackId: fallbackSlackId || cookies.hcSlackId || "",
        }),
      };
    }

    async function requireadmin(req, { logDenied = true } = {}) {
      const session = await getsessionprofile(req);

      if (!session.ok) {
        return {
          ok: false,
          response: errorresponse(
            session.status,
            session.code,
            session.message,
            {},
            {},
            false,
          ),
        };
      }

      const adminSlackId = normalizeslackid(
        session.profile.slackId || session.cookies.hcSlackId,
      );

      if (adminSlackId !== adminslackid) {
        if (logDenied) {
          recordevent("admin_access", "failure", {
            slackId: adminSlackId || "unknown",
            ip: getrequestip(req),
            code: "admin_only",
          });
        }
        return {
          ok: false,
          response: errorresponse(
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
      case "/login":
      case "/login/": {
        return new Response(null, {
          status: 302,
          headers: {
            Location: buildfrontendlocation({ view: "login" }),
          },
        });
      }

      case "/auth/start": {
        if (!env.HC_CLIENT_ID) {
          return new Response("Missing HC_CLIENT_ID", { status: 500 });
        }

        const state = randomstate();
        const authUrl = new URL(`${hcauthbase}/oauth/authorize`);
        authUrl.searchParams.set("client_id", env.HC_CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", getredirecturi());
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", hcoauthscope);
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
        const ip = getrequestip(request);

        if (!code || !state || state !== cookies.hcOauthState) {
          recordmetric("auth", "failure");
          counterror("oauth_state_invalid");
          recordevent("auth_callback", "failure", {
            code: "oauth_state_invalid",
          });
          const target = buildfrontendlocation({
            oauth_error: "Hack Club Auth verification failed",
          });
          return new Response(null, {
            status: 302,
            headers: {
              Location: target,
              "Set-Cookie": serializeCookie("hcOauthState", "", 0),
            },
          });
        }

        const tokenData = await hctokenexchange({
          client_id: env.HC_CLIENT_ID,
          client_secret: env.HC_CLIENT_SECRET,
          redirect_uri: getredirecturi(),
          code,
          grant_type: "authorization_code",
        });

        if (!tokenData.access_token) {
          recordmetric("auth", "failure");
          counterror("oauth_token_exchange_failed");
          recordevent("auth_callback", "failure", {
            code: "oauth_token_exchange_failed",
            details: tokenData.error || "token_exchange_failed",
          });
          const target = buildfrontendlocation({
            oauth_error: tokenData.error || "Token exchange failed",
          });
          return new Response(null, {
            status: 302,
            headers: {
              Location: target,
              "Set-Cookie": serializeCookie("hcOauthState", "", 0),
            },
          });
        }

        const me = await hcme(tokenData.access_token);
        if (!me.ok) {
          recordmetric("auth", "failure");
          counterror("hc_profile_fetch_failed");
          recordevent("auth_callback", "failure", {
            code: "hc_profile_fetch_failed",
            status: me.status,
          });
          const target = buildfrontendlocation({
            oauth_error: "Could not load your Hack Club profile",
          });
          return new Response(null, {
            status: 302,
            headers: {
              Location: target,
              "Set-Cookie": serializeCookie("hcOauthState", "", 0),
            },
          });
        }

        const profile = parsehcprofile(me.data || {});
        recordmetric("auth", "success");
        recordevent("auth_callback", "success", {
          slackId: profile.slackId || "unknown",
        });

        let sessionToken = "";
        if (kv) {
          sessionToken = crypto.randomUUID().replace(/-/g, "");
          await writesessiontoken(sessionToken, {
            accessToken: tokenData.access_token,
            slackId: profile.slackId,
          }, request);
        }

        const headers = new Headers({
          Location: buildfrontendlocation({
            auth_attempted: "1",
            ...(sessionToken ? { session_token: sessionToken } : {}),
          }),
        });
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
        const bearerToken = parsebearersessiontoken(request);
        await deletesessiontoken(bearerToken);

        const headers = new Headers({ Location: buildfrontendlocation() });
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
              httpOnly: !publiccookiekeys.includes(key),
            }),
          );
        });
        return new Response(null, { status: 302, headers });
      }

      case "/ysws.json":
        return withCors(Response.json(YSWS_LIST));

      case "/api/user": {
        const session = await getsessionprofile(request);
        if (!session.ok) {
          return jsonresponse(
            { ok: false, error: session.code, code: session.code },
            session.status,
          );
        }

        const fallbackSlackId = (session.cookies.hcSlackId || "")
          .trim()
          .toUpperCase();
        const profile = session.profile;
        const slackId = normalizeslackid(profile.slackId || fallbackSlackId);
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
              membership[p.channel] = await isuserinchannel(p.channel, slackId);
            }),
          );
        } else {
          for (const p of YSWS_LIST) membership[p.channel] = false;
        }

        const rsvpDone = await readuserrsvpdone(slackId);

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

        const ip = getrequestip(request);
        const rateLimit = await consumersvpratelimit(ip);
        const rateLimitHeaders = {
          "X-RateLimit-Limit": String(rsvpratelimitmaxrequests),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.resetAt),
        };

        if (!rateLimit.allowed) {
          recordmetric("rsvp", "failure");
          recordevent("rsvp_done", "failure", {
            code: "rate_limited",
            ip,
          });
          return errorresponse(
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

        const session = await getsessionprofile(request);
        if (!session.ok) {
          recordmetric("rsvp", "failure");
          return errorresponse(
            session.status,
            session.code,
            session.message,
            {},
            rateLimitHeaders,
            false,
          );
        }

        if (!kv) {
          recordmetric("rsvp", "failure");
          return errorresponse(
            500,
            "missing_storage",
            "RSVP completion storage is not configured.",
            {},
            rateLimitHeaders,
          );
        }

        const body = await request.json().catch(() => null);
        const channel = normalizeslackid(body?.channel || "");
        const done = body?.done !== false;

        if (!channel) {
          recordmetric("rsvp", "failure");
          recordevent("rsvp_done", "failure", {
            code: "invalid_payload",
            ip,
          });
          return errorresponse(
            400,
            "invalid_payload",
            "RSVP updates must include a valid channel ID.",
            {},
            rateLimitHeaders,
          );
        }

        if (!allowedChannels.has(channel)) {
          recordmetric("rsvp", "failure");
          recordevent("rsvp_done", "failure", {
            channel,
            code: "channel_not_allowed",
            ip,
          });
          return errorresponse(
            403,
            "channel_not_allowed",
            "That channel isn't on the allowed list.",
            { channel },
            rateLimitHeaders,
          );
        }

        const slackId = normalizeslackid(
          session.profile.slackId || session.cookies.hcSlackId,
        );

        if (!slackId) {
          recordmetric("rsvp", "failure");
          recordevent("rsvp_done", "failure", {
            channel,
            code: "missing_slack_id",
            ip,
          });
          return errorresponse(
            400,
            "missing_slack_id",
            "Your account is missing the Slack scope. Sign out and back in.",
            {},
            rateLimitHeaders,
          );
        }

        const currentState = await readuserrsvpdone(slackId);
        currentState[channel] = done;
        const rsvpDone = await writeuserrsvpdone(slackId, currentState);

        recordmetric("rsvp", "success");
        recordevent("rsvp_done", "success", {
          slackId,
          channel,
          done,
        });

        return jsonresponse({
          ok: true,
          slackId,
          channel,
          done,
          rsvpDone,
        }, 200, rateLimitHeaders);
      }

      case "/api/join": {
        if (request.method !== "POST") break;

        const ip = getrequestip(request);
        const rateLimit = await consumejoinratelimit(ip);
        const rateLimitHeaders = {
          "X-RateLimit-Limit": String(joinratelimitmaxrequests),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.resetAt),
        };

        if (!rateLimit.allowed) {
          recordmetric("join", "failure");
          recordevent("join", "failure", {
            code: "rate_limited",
          });
          return errorresponse(
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

        const session = await getsessionprofile(request);
        if (!session.ok) {
          recordmetric("join", "failure");
          recordevent("join", "failure", {
            code: session.code,
          });
          return errorresponse(
            session.status,
            session.code,
            session.message,
            {},
            rateLimitHeaders,
            false,
          );
        }

        if (!env.SLACK_TOKEN) {
          recordmetric("join", "failure");
          recordevent("join", "failure", {
            code: "missing_slack_token",
          });
          return errorresponse(
            500,
            "missing_slack_token",
            "Slack isn't set up. Contact the site owner.",
            {},
            rateLimitHeaders,
          );
        }

        const data = await request.json().catch(() => null);
        const channel = normalizeslackid(data?.channel || "");

        if (!channel) {
          recordmetric("join", "failure");
          recordevent("join", "failure", {
            code: "invalid_payload",
          });
          return errorresponse(
            400,
            "invalid_payload",
            "Join requests must include a valid channel ID.",
            {},
            rateLimitHeaders,
          );
        }

        if (!allowedChannels.has(channel)) {
          recordmetric("join", "failure");
          recordevent("join", "failure", {
            channel,
            code: "channel_not_allowed",
          });
          return errorresponse(
            403,
            "channel_not_allowed",
            "That channel isn't on the allowed list.",
            { channel },
            rateLimitHeaders,
          );
        }

        const profile = session.profile;
        const slackId = normalizeslackid(
          profile.slackId || session.cookies.hcSlackId,
        );

        if (!slackId) {
          recordmetric("join", "failure");
          recordevent("join", "failure", {
            channel,
            code: "missing_slack_id",
          });
          return errorresponse(
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
          recordmetric("join", "failure");
          recordevent("join", "failure", {
            channel,
            slackId,
            code: inviteData.error || "invite_failed",
          });
          return errorresponse(
            400,
            inviteData.error || "invite_failed",
            "Could not add you to that Slack channel.",
            { channel },
            rateLimitHeaders,
          );
        }

        recordmetric("join", "success");
        recordevent("join", "success", {
          channel,
          slackId,
          result: inviteData.error === "already_in_channel" ? "already_in_channel" : "invited",
        });

        return jsonresponse({ ok: true }, 200, rateLimitHeaders);
      }

      case "/api/admin/metrics": {
        const admin = await requireadmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        return jsonresponse({
          ok: true,
          adminSlackId: admin.slackId,
          metrics: getmetricssnapshot(),
        });
      }

      case "/api/admin/access": {
        const admin = await requireadmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        return jsonresponse({
          ok: true,
          adminSlackId: admin.slackId,
        });
      }

      case "/api/admin/audit": {
        const admin = await requireadmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        if (request.method === "DELETE") {
          const eventId = String(url.searchParams.get("id") || "").trim();

          if (eventId) {
            const deleted = await deleteauditeventbyid(eventId);
            if (!deleted) {
              return errorresponse(
                404,
                "audit_event_not_found",
                "That audit event could not be found.",
              );
            }

            return jsonresponse({
              ok: true,
              adminSlackId: admin.slackId,
              deletedId: eventId,
            });
          }

          const clearedCount = runtimeState.auditEvents.length;
          runtimeState.auditEvents = [];
          await persistaudit();

          return jsonresponse({
            ok: true,
            adminSlackId: admin.slackId,
            clearedCount,
          });
        }

        if (request.method !== "GET") {
          return errorresponse(
            405,
            "method_not_allowed",
            "Only GET and DELETE are supported for admin audit.",
          );
        }

        const limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit") || 25)),
        );
        const prunedCount = pruneauditevents();

        return jsonresponse({
          ok: true,
          adminSlackId: admin.slackId,
          retentionDays: auditretentiondays,
          prunedCount,
          events: runtimeState.auditEvents.slice(0, limit),
        });
      }

      case "/api/admin/errors": {
        const admin = await requireadmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        if (request.method !== "DELETE") {
          return errorresponse(
            405,
            "method_not_allowed",
            "Only DELETE is supported for admin errors.",
          );
        }

        const clearedTotal = runtimeState.metrics.errors.total || 0;
        await clearerrormetrics();

        return jsonresponse({
          ok: true,
          adminSlackId: admin.slackId,
          clearedTotal,
        });
      }

      case "/api/admin/view-as": {
        if (request.method !== "GET") break;

        const admin = await requireadmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        const targetId = normalizeslackid(url.searchParams.get("slackId") || "");
        if (!targetId) {
          return errorresponse(400, "missing_slack_id", "Provide a slackId query param.");
        }

        let slackUser = null;
        if (env.SLACK_TOKEN) {
          const slackUserData = await slackGet("users.info", { user: targetId }, env);
          if (slackUserData?.ok && slackUserData.user) {
            slackUser = slackUserData.user;
          }
        }

        if (!slackUser) {
          return errorresponse(404, "user_not_found", "Could not find a Slack user with that ID.");
        }

        const membership = {};
        if (env.SLACK_TOKEN) {
          await Promise.all(
            YSWS_LIST.map(async (p) => {
              membership[p.channel] = await isuserinchannel(p.channel, targetId);
            }),
          );
        } else {
          for (const p of YSWS_LIST) membership[p.channel] = false;
        }

        const rsvpDone = await readuserrsvpdone(targetId);

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

        return jsonresponse({
          ok: true,
          ...profile,
          membership,
          rsvpDone,
        });
      }

      case "/api/admin/lookup": {
        if (request.method !== "GET") break;

        const admin = await requireadmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        const targetId = normalizeslackid(url.searchParams.get("slackId") || "");
        if (!targetId) {
          return errorresponse(400, "missing_slack_id", "Provide a slackId query param.");
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
              membership[p.channel] = await isuserinchannel(p.channel, targetId);
            }),
          );
        } else {
          for (const p of YSWS_LIST) membership[p.channel] = false;
        }

        const rsvpDone = await readuserrsvpdone(targetId);

        return jsonresponse({
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

        const admin = await requireadmin(request);
        if (!admin.ok) return admin.response;

        if (!env.SLACK_TOKEN) {
          return errorresponse(500, "missing_slack_token", "Slack isn't set up. Contact the site owner.");
        }

        const body = await request.json().catch(() => null);
        const channel = normalizeslackid(body?.channel || "");
        const targetId = normalizeslackid(body?.slackId || "");

        if (!channel || !targetId) {
          return errorresponse(400, "invalid_payload", "Provide channel and slackId.");
        }

        if (!allowedChannels.has(channel)) {
          return errorresponse(403, "channel_not_allowed", "That channel isn't on the allowed list.", { channel });
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

        recordevent("admin_test_join", inviteData.ok || inviteData.error === "already_in_channel" ? "success" : "failure", {
          adminSlackId: admin.slackId,
          channel,
          slackId: targetId,
          result: inviteData.error || "invited",
        });

        if (!inviteData.ok && inviteData.error !== "already_in_channel") {
          return errorresponse(400, inviteData.error || "invite_failed", "Could not add that user to the channel.", { channel });
        }

        return jsonresponse({
          ok: true,
          channel,
          slackId: targetId,
          result: inviteData.error === "already_in_channel" ? "already_in_channel" : "invited",
        });
      }

      case "/api/admin/test-rsvp": {
        if (request.method !== "POST") break;

        const admin = await requireadmin(request, { logDenied: false });
        if (!admin.ok) return admin.response;

        if (!kv) {
          return errorresponse(500, "missing_storage", "RSVP completion storage is not configured.");
        }

        const body = await request.json().catch(() => null);
        const channel = normalizeslackid(body?.channel || "");
        const targetId = normalizeslackid(body?.slackId || "");
        const done = body?.done !== false;

        if (!channel || !targetId) {
          return errorresponse(400, "invalid_payload", "Provide channel and slackId.");
        }

        if (!allowedChannels.has(channel)) {
          return errorresponse(403, "channel_not_allowed", "That channel isn't on the allowed list.", { channel });
        }

        const currentState = await readuserrsvpdone(targetId);
        currentState[channel] = done;
        const rsvpDone = await writeuserrsvpdone(targetId, currentState);

        recordevent("admin_test_rsvp", "success", {
          adminSlackId: admin.slackId,
          channel,
          slackId: targetId,
          done,
        });

        return jsonresponse({
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
