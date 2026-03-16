import YSWS_LIST from "./public/ysws.json";

const HC_AUTH_BASE = "https://auth.hackclub.com";
const HC_OAUTH_SCOPE = "openid profile email name slack_id verification_status";
const PUBLIC_COOKIE_KEYS = ["hcName", "hcEmail", "hcAvatar"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = (env.FRONTEND_ORIGIN || "").trim();

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };

    function withCors(response) {
      const headers = new Headers(response.headers);
      if (allowedOrigin && origin === allowedOrigin) {
        for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: allowedOrigin ? corsHeaders : {},
      });
    }

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

    if (url.pathname === "/auth/start") {
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

    if (url.pathname === "/auth/callback") {
      const cookies = parseCookies(request);
      const code = (url.searchParams.get("code") || "").trim();
      const state = (url.searchParams.get("state") || "").trim();

      if (!code || !state || state !== cookies.hcOauthState) {
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
      const profile = parseHCProfile(me.data || {});

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

    if (url.pathname === "/auth/logout") {
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

    if (url.pathname === "/ysws.json") {
      return withCors(Response.json(YSWS_LIST));
    }

    if (url.pathname === "/api/user") {
      const cookies = parseCookies(request);
      const accessToken = (cookies.hcAccessToken || "").trim();
      const fallbackSlackId = (cookies.hcSlackId || "").trim().toUpperCase();

      if (!accessToken) {
        return withCors(
          Response.json(
            { ok: false, error: "not_authenticated" },
            { status: 401 },
          ),
        );
      }

      const me = await hcMe(accessToken);
      if (!me.ok) {
        return withCors(
          Response.json({ ok: false, error: "auth_expired" }, { status: 401 }),
        );
      }

      const profile = parseHCProfile(me.data || {}, cookies);
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

      return withCors(
        Response.json({
          ok: true,
          slackId,
          username: slackUsername || profile.username,
          name: slackName || profile.name,
          avatar: slackAvatar || profile.avatar,
          email: slackEmail || profile.email,
          membership,
          verificationStatus: profile.verificationStatus,
          verificationLabel: profile.verificationLabel,
          isVerified: profile.isVerified,
          yswsEligible: profile.yswsEligible,
        }),
      );
    }

    if (url.pathname === "/api/join" && request.method === "POST") {
      const cookies = parseCookies(request);
      const accessToken = (cookies.hcAccessToken || "").trim();

      if (!accessToken) {
        return withCors(
          Response.json(
            { ok: false, error: "not_authenticated" },
            { status: 401 },
          ),
        );
      }

      if (!env.SLACK_TOKEN) {
        return withCors(
          Response.json(
            { ok: false, error: "missing_slack_token" },
            { status: 500 },
          ),
        );
      }

      const data = await request.json().catch(() => null);
      if (!data?.channel) {
        return withCors(
          Response.json(
            { ok: false, error: "invalid_payload" },
            { status: 400 },
          ),
        );
      }

      const me = await hcMe(accessToken);
      const profile = parseHCProfile(me.data || {}, cookies);
      const slackId = normalizeSlackId(profile.slackId || cookies.hcSlackId);

      if (!slackId) {
        return withCors(
          Response.json(
            {
              ok: false,
              error: "missing_slack_id",
              message: "Grant slack_id scope and reconnect.",
            },
            { status: 400 },
          ),
        );
      }

      const invite = await fetch("https://slack.com/api/conversations.invite", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SLACK_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel: data.channel, users: slackId }),
      });

      const inviteData = await invite
        .json()
        .catch(() => ({ ok: false, error: "invite_failed" }));
      if (!inviteData.ok && inviteData.error !== "already_in_channel") {
        return withCors(
          Response.json(
            { ok: false, error: inviteData.error || "invite_failed" },
            { status: 400 },
          ),
        );
      }

      return withCors(Response.json({ ok: true }));
    }

    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true, service: "ysws-rsvp-hca" }));
    }

    return withCors(new Response("Not found", { status: 404 }));
  },
};
