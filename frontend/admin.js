      const apibase =
        window.__API_BASE__ || "https://ysws-rsvp-hca.sdheeraj.workers.dev";
      const noaccessurl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const sessiontokenstoragekey = "ysws_session_token";

      function api(path) {
        return `${apibase}${path}`;
      }

      function getsessiontoken() {
        const token = String(localStorage.getItem(sessiontokenstoragekey) || "").trim();
        if (!token) return "";
        if (!/^[a-f0-9]{32,128}$/i.test(token)) {
          localStorage.removeItem(sessiontokenstoragekey);
          return "";
        }
        return token;
      }

      function getauthheaders() {
        const token = getsessiontoken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      }

      async function apifetch(path, init = {}) {
        const baseheaders = getauthheaders();
        const nextheaders = {
          ...baseheaders,
          ...(init.headers || {}),
        };
        return fetch(api(path), {
          ...init,
          credentials: "include",
          headers: nextheaders,
        });
      }

      async function apiget(path) {
        return apifetch(path);
      }

      async function readjson(response, fallback) {
        return response.json().catch(() => fallback);
      }

      function formatpercent(value) {
        return `${Number(value || 0).toFixed(1).replace(/\.0$/, "")}%`;
      }

      function formatdatetime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Unknown time";
        return date.toLocaleString();
      }

      function getswaloptions(overrides = {}) {
        return {
          background: "#111827",
          color: "#f8fafc",
          buttonsStyling: false,
          customClass: {
            popup: "hc-swal-popup",
            confirmButton: "swal-confirm-btn",
            cancelButton: "swal-cancel-btn",
          },
          ...overrides,
        };
      }

      async function showpopup({ icon = "info", title = "Notice", text = "" } = {}) {
        if (window.Swal) {
          return window.Swal.fire(getswaloptions({ icon, title, text, confirmButtonText: "OK" }));
        }

        setstatus("error", text || title);
        return null;
      }

      async function showconfirm({ title, text, confirmbuttontext = "Continue", cancelbuttontext = "Cancel" }) {
        if (window.Swal) {
          return window.Swal.fire(
            getswaloptions({
              icon: "question",
              title,
              text,
              showCancelButton: true,
              confirmButtonText: confirmbuttontext,
              cancelButtonText: cancelbuttontext,
              reverseButtons: true,
              focusCancel: true,
            }),
          );
        }

        setstatus("error", text || title || "Confirmation dialog unavailable.");
        return { isConfirmed: false };
      }

      const statusbox = document.getElementById("adminstatus");
      const auditlist = document.getElementById("adminauditlist");
      const auditmeta = document.getElementById("adminauditmeta");
      const errorcodes = document.getElementById("adminerrorcodes");
      const authrate = document.getElementById("adminauthrate");
      const authmeta = document.getElementById("adminauthmeta");
      const joinrate = document.getElementById("adminjoinrate");
      const joinmeta = document.getElementById("adminjoinmeta");
      const errorcount = document.getElementById("adminerrorcount");
      const ratelimitmeta = document.getElementById("adminratelimitmeta");
      const rsvpratelimitmeta = document.getElementById("adminrsvpratelimitmeta");
      const retentionnote = document.getElementById("adminretentionnote");
      const refreshbtn = document.getElementById("refreshadminbtn");
      const adminpanel = document.getElementById("adminpanel");
      const adminnoaccess = document.getElementById("adminnoaccess");
      const viewasmodal = document.getElementById("viewasmodal");
      const viewasmodalcontent = document.getElementById("viewasmodalcontent");
      const viewasmodalstatus = document.getElementById("viewasmodalstatus");
      const sourcecodeurl = "https://github.com/17sdheeraj/yswsrsvp";
      let yswscatalog = [];
      let viewasstate = null;
      let currentauditpage = 1;
      const auditperpage = 5;
      let allauditevents = [];

      function rendernoaccess(code = "admin_only") {
        const message =
          "ay! what are you doing here, stop poking around the admin dashboard theres nothing here for you to see. if you want check out the sourcecode";

        adminpanel.style.display = "none";
        adminnoaccess.style.display = "grid";
        adminnoaccess.innerHTML = `
          <img src="https://hackclub.com/404/dinobox.svg" alt="Dino guard" class="adminnoaccessdino" />
          <h2>Nice try sherlock👀</h2>
          <p>${message} <a href="${sourcecodeurl}" target="_blank" rel="noreferrer">here</a>.</p>
          <div class="adminnoaccessactions">
            <a class="buttonlink joined" href="./index.html">Back to Home</a>
            <a class="buttonlink" href="${noaccessurl}" target="_blank" rel="noreferrer">Mystery button</a>
          </div>
        `;
      }

      function geterrorcodelabel(code) {
        const labels = {
          rate_limited: "Slow down! You're making too many requests so you have been ratelimited",
          admin_only: "No VIP for you! This action is only for admins",
          not_authenticated: "Session vanished into thin air, try logging in",
          auth_expired: "Session timed out, it went for a coffee",
          oauth_state_invalid: "Login handshake got scrambled",
          oauth_token_exchange_failed: "Login token machine jammed",
          invalid_payload: "Payload looks a little cursed",
          channel_not_allowed: "Channel is outside the approved list, this aint supposed to happen",
          missing_slack_id: "No Slack ID was provided",
          user_not_found: "Could not find that Slack user",
          invite_failed: "Slack invite API said nope, try again later",
          audit_event_not_found: "That audit log item already disappeared",
        };

        return labels[code] || "Something odd happened";
      }

      function formatapierror(data, fallback = "Request failed.") {
        const code = String(data?.code || data?.error || "").trim();
        if (code) return geterrorcodelabel(code);
        return String(data?.message || fallback);
      }

      function setstatus(type, msg) {
        statusbox.className = "status";
        if (!msg) {
          statusbox.textContent = "";
          return;
        }
        statusbox.classList.add(type);
        statusbox.textContent = msg;
      }

      function rendererrorcodes(bycode = {}) {
        errorcodes.innerHTML = "";
        const entries = Object.entries(bycode).sort((a, b) => b[1] - a[1]);

        if (!entries.length) {
          const empty = document.createElement("p");
          empty.className = "adminempty";
          empty.textContent = "No errors yet.";
          errorcodes.appendChild(empty);
          return;
        }

        entries.forEach(([code, count]) => {
          const row = document.createElement("div");
          row.className = "errorcodeitem";

          const chip = document.createElement("span");
          chip.className = "codechip";
          chip.textContent = code;

          const value = document.createElement("strong");
          value.textContent = String(count);

          const meta = document.createElement("p");
          meta.className = "auditmeta";
          meta.textContent = geterrorcodelabel(code);

          row.append(chip, value, meta);
          errorcodes.appendChild(row);
        });
      }

      function renderaudit(events = []) {
        allauditevents = events;
        currentauditpage = 1;
        renderauditpage();
      }

      function renderauditpage() {
        const pagination = document.getElementById("auditpagination");
        auditlist.innerHTML = "";

        const totalpages = Math.max(1, Math.ceil(allauditevents.length / auditperpage));
        currentauditpage = Math.min(currentauditpage, totalpages);

        auditmeta.textContent = `${allauditevents.length} total event${allauditevents.length === 1 ? "" : "s"}`;

        if (!allauditevents.length) {
          const empty = document.createElement("p");
          empty.className = "adminempty";
          empty.textContent = "Nothing here yet, Its suspiciously quiet.";
          auditlist.appendChild(empty);
          pagination.innerHTML = "";
          return;
        }

        const startidx = (currentauditpage - 1) * auditperpage;
        const endidx = startidx + auditperpage;
        const pageevents = allauditevents.slice(startidx, endidx);

        pageevents.forEach((event, idx) => {
          const item = document.createElement("div");
          item.className = "audititem";

          const contentwrapper = document.createElement("div");
          contentwrapper.style.flex = "1";

          const head = document.createElement("div");
          head.className = "audititem-head";

          const type = document.createElement("span");
          type.className = "audittype";
          type.textContent = String(event.type || "event").replace(/_/g, " ");

          const outcome = document.createElement("span");
          outcome.className = `auditoutcome ${event.outcome === "success" ? "success" : "failure"}`;
          outcome.textContent = event.outcome || "unknown";

          head.append(type, outcome);

          const meta = document.createElement("p");
          meta.className = "auditmeta";
          meta.textContent = formatdatetime(event.timestamp);

          const details = document.createElement("p");
          details.className = "auditdetails";
          details.textContent = [
            event.code ? `code: ${event.code}` : "",
            event.channel ? `channel: ${event.channel}` : "",
            event.slackId ? `slack: ${event.slackId}` : "",
            event.result ? `result: ${event.result}` : "",
            event.status ? `status: ${event.status}` : "",
            event.details ? `details: ${event.details}` : "",
          ]
            .filter(Boolean)
            .join(" | ");

          contentwrapper.append(head, meta);
          if (details.textContent) contentwrapper.appendChild(details);

          const deletebtn = document.createElement("button");
          deletebtn.className = "audititem-delete";
          deletebtn.textContent = "Delete";
          deletebtn.addEventListener("click", async () => {
            deletebtn.disabled = true;
            deletebtn.textContent = "Deleting...";

            const deleted = await deleteauditevent(event.id);
            if (!deleted) {
              deletebtn.disabled = false;
              deletebtn.textContent = "Delete";
              return;
            }

            const eventindex = startidx + idx;
            allauditevents.splice(eventindex, 1);
            renderauditpage();
          });

          item.append(contentwrapper, deletebtn);
          auditlist.appendChild(item);
        });

        pagination.innerHTML = "";
        if (totalpages > 1) {
          const prevbtn = document.createElement("button");
          prevbtn.textContent = "← Prev";
          prevbtn.disabled = currentauditpage === 1;
          prevbtn.addEventListener("click", () => {
            if (currentauditpage > 1) {
              currentauditpage--;
              renderauditpage();
            }
          });
          pagination.appendChild(prevbtn);

          for (let i = 1; i <= totalpages; i++) {
            const pagebtn = document.createElement("button");
            pagebtn.textContent = String(i);
            pagebtn.className = i === currentauditpage ? "active" : "";
            pagebtn.addEventListener("click", () => {
              currentauditpage = i;
              renderauditpage();
            });
            pagination.appendChild(pagebtn);
          }

          const nextbtn = document.createElement("button");
          nextbtn.textContent = "Next →";
          nextbtn.disabled = currentauditpage === totalpages;
          nextbtn.addEventListener("click", () => {
            if (currentauditpage < totalpages) {
              currentauditpage++;
              renderauditpage();
            }
          });
          pagination.appendChild(nextbtn);
        }
      }

      async function loaddata() {
        setstatus("", "");
        refreshbtn.disabled = true;

        try {
          const [metricsres, auditres] = await Promise.all([
            apiget("/api/admin/metrics"),
            apiget("/api/admin/audit?limit=100"),
          ]);

          const metricsdata = await readjson(metricsres, { ok: false });
          const auditdata = await readjson(auditres, { ok: false });

          if (!metricsres.ok || !metricsdata.ok) {
            throw new Error(metricsdata.message || "Couldn't load metrics right now.");
          }

          if (!auditres.ok || !auditdata.ok) {
            throw new Error(auditdata.message || "Couldn't load the audit log right now.");
          }

          const m = metricsdata.metrics || {};
          authrate.textContent = formatpercent(m.auth?.successRate);
          authmeta.textContent = `${m.auth?.success || 0} logins out of ${m.auth?.attempts || 0}`;
          joinrate.textContent = formatpercent(m.join?.successRate);
          joinmeta.textContent = `${m.join?.success || 0} successful joins out of ${m.join?.attempts || 0}`;
          errorcount.textContent = String(m.errors?.total || 0);

          const windowmin = Math.round(Number(m.join?.rateLimit?.windowMs || 0) / 60000);
          const maxreq = Number(m.join?.rateLimit?.maxRequests || 0);
          const rsvpwindowmin = Math.round(Number(m.rsvp?.rateLimit?.windowMs || 0) / 60000);
          const rsvpmaxreq = Number(m.rsvp?.rateLimit?.maxRequests || 0);
          ratelimitmeta.textContent = maxreq
            ? `${maxreq} join requests per IP every ${windowmin} min`
            : "Join rate limit disabled";
          rsvpratelimitmeta.textContent = rsvpmaxreq
            ? `${rsvpmaxreq} RSVP updates per IP every ${rsvpwindowmin} min`
            : "RSVP rate limit disabled";
          retentionnote.textContent = `Audit logs are retained for ${auditdata.retentionDays || m.audit?.retentionDays || 14} days.`;

          rendererrorcodes(m.errors?.byCode || {});
          renderaudit(auditdata.events || []);
        } catch (err) {
          setstatus("error", err.message || "Dashboard had a tiny wobble. Try again.");
        } finally {
          refreshbtn.disabled = false;
        }
      }

      async function clearauditlog() {
        const confirm = await showconfirm({
          title: "Clear audit log?",
          text: "This deletes all current entries.",
          confirmbuttontext: "Yes, clear it",
          cancelbuttontext: "Cancel",
        });
        if (!confirm?.isConfirmed) return;

        const clearbtn = document.getElementById("clearauditbtn");
        clearbtn.disabled = true;
        setstatus("", "");

        try {
          const response = await apifetch("/api/admin/audit", {
            method: "DELETE",
          });
          const data = await readjson(response, { ok: false });

          if (!response.ok || !data.ok) {
            throw new Error(formatapierror(data, "Couldn't clear the audit log."));
          }

          setstatus("success", `Cleared ${data.clearedCount || 0} audit event${data.clearedCount === 1 ? "" : "s"}.`);
          await loaddata();
        } catch (err) {
          setstatus("error", err.message || "Couldn't clear the audit log right now.");
        } finally {
          clearbtn.disabled = false;
        }
      }

      async function deleteauditevent(eventid) {
        if (!eventid) return false;

        setstatus("", "");

        try {
          const response = await apifetch(`/api/admin/audit?id=${encodeURIComponent(eventid)}`, {
            method: "DELETE",
          });
          const data = await readjson(response, { ok: false });

          if (!response.ok || !data.ok) {
            throw new Error(formatapierror(data, "Couldn't delete that audit event."));
          }

          setstatus("success", "Deleted audit event.");
          return true;
        } catch (err) {
          setstatus("error", err.message || "Couldn't delete that audit event right now.");
          return false;
        }
      }

      async function clearerrorsbycode() {
        const confirm = await showconfirm({
          title: "Clear all errors?",
          text: "This will reset the error code statistics.",
          confirmbuttontext: "Yes, clear them",
          cancelbuttontext: "Cancel",
        });
        if (!confirm?.isConfirmed) return;

        const clearerrorsbtn = document.getElementById("clearerrorsbtn");
        clearerrorsbtn.disabled = true;
        setstatus("", "");

        try {
          const response = await apifetch("/api/admin/errors", {
            method: "DELETE",
          });
          const data = await readjson(response, { ok: false });

          if (!response.ok || !data.ok) {
            throw new Error(formatapierror(data, "Couldn't clear errors."));
          }

          setstatus("success", "Cleared all error statistics.");
          await loaddata();
        } catch (err) {
          setstatus("error", err.message || "Couldn't clear errors right now.");
        } finally {
          clearerrorsbtn.disabled = false;
        }
      }

      async function viewas() {
        const input = document.getElementById("viewasslackidinput");
        const btn = document.getElementById("viewasbtn");
        const slackid = input.value.trim().toUpperCase();

        if (!slackid) {
          await showpopup({
            icon: "warning",
            title: "Slack ID needed",
            text: "Enter a Slack ID first.",
          });
          return;
        }

        btn.disabled = true;
        viewasmodal.style.display = "flex";
        viewasmodalcontent.innerHTML = `<p style="color:var(--hcmuted); text-align:center;">Loading…</p>`;
        viewasmodalstatus.textContent = "";

        try {
          const response = await apiget(`/api/admin/view-as?slackId=${encodeURIComponent(slackid)}`);
          const data = await readjson(response, { ok: false });

          if (!data.ok) {
            viewasmodalcontent.innerHTML = `<p class="resulterr">Failed: ${formatapierror(data, "Request failed.")}</p>`;
            return;
          }

          if (!yswscatalog.length) {
            await loadyswscatalog();
          }
          viewasstate = {
            ...data,
            membership: { ...(data.membership || {}) },
            rsvpdone: { ...(data.rsvpDone || {}) },
          };
          renderviewasdashboard();
        } catch (_err) {
          viewasmodalcontent.innerHTML = `<p class="resulterr">Request failed.</p>`;
        } finally {
          btn.disabled = false;
        }
      }

      function renderviewasdashboard(actionmessage = "") {
        if (!viewasstate) {
          viewasmodalcontent.innerHTML = `<p class="resulterr">No user selected.</p>`;
          return;
        }

        const data = viewasstate;
        const rows = (yswscatalog.length
          ? yswscatalog
          : Object.keys(data.membership || {}).map((channel) => ({
              name: channel,
              channel,
              form: "",
            })))
          .map((item) => ({
            ...item,
            joined: !!data.membership?.[item.channel],
            rsvpdone: !!data.rsvpDone?.[item.channel],
          }))
          .sort((a, b) => Number(a.joined) - Number(b.joined) || a.name.localeCompare(b.name));

        const joinedcount = rows.filter((item) => item.joined).length;
        const completedcount = rows.filter((item) => item.joined && item.rsvpdone).length;
        const totalcount = rows.length;
        const remainingcount = Math.max(0, totalcount - completedcount);
        const completionpercent = totalcount ? Math.round((completedcount / totalcount) * 100) : 0;
        const verificationlabel = data.verificationLabel || "Unknown";
        const verificationstatus = data.verificationStatus || "Unavailable";
        const eligibilitylabel =
          data.yswsEligible === true
            ? "Eligible"
            : data.yswsEligible === false
              ? "Not eligible"
              : "Unknown";

        const cardshtml = rows.length
          ? rows
              .map(
                (item) => `
                  <div class="card viewascard${item.joined && item.rsvpdone ? " cardcomplete" : item.joined || item.rsvpdone ? " cardpartial" : ""}">
                    <div class="cardhead">
                      <div class="cardtitlegroup">
                        <h3>${item.name}</h3>
                        <span class="channelid">${item.channel}</span>
                      </div>
                      <button
                        type="button"
                        class="rsvptoggle viewasrsvpbtn ${item.rsvpdone ? "ischecked" : ""}"
                        data-channel="${item.channel}"
                        data-name="${item.name}"
                        data-done="${item.rsvpdone ? "false" : "true"}"
                        aria-label="${item.rsvpdone ? `Unmark RSVP done for ${item.name}` : `Mark RSVP done for ${item.name}` }"
                        title="${item.rsvpdone ? "Undo RSVP done" : "Mark RSVP done"}"
                      ></button>
                    </div>
                    <div class="actions">
                      ${
                        item.joined
                          ? '<button class="joined" disabled>Joined</button>'
                          : `<button class="viewasjoinbtn" data-channel="${item.channel}" data-name="${item.name}">Add user to channel</button>`
                      }
                      <button ${item.form ? `onclick="window.open('${item.form}', '_blank')"` : "disabled"}>Fill RSVP</button>
                      <button class="joined" disabled>Description</button>
                    </div>
                  </div>
                `,
              )
              .join("")
          : '<div class="card viewascard"><h3>No programs found</h3><p class="muted">Could not load channel catalog.</p></div>';

        viewasmodalcontent.innerHTML = `
          <div class="viewasshell">
            <div class="viewashead">
              <div class="user">
                <img class="avatar" src="${data.avatar || "https://user-cdn.hackclub-assets.com/019cf11f-eade-7304-ab15-71833ccc4c32/icon-rounded.svg"}" alt="avatar" />
                <div class="usermeta">
                  <h3>Viewing as ${data.name || data.username || data.slackId || "user"}</h3>
                  <div class="slackidrow">
                    <span class="slackidtext">Slack ID: <strong>${data.slackId || "—"}</strong></span>
                    <span class="slackidtext">Username: <strong>${data.username ? `@${data.username}` : "—"}</strong></span>
                    <span class="slackidtext">Email: <strong>${data.email || "—"}</strong></span>
                  </div>
                  <div class="verificationrow">
                    <span class="verificationpill ${data.isVerified === true ? "verified" : data.isVerified === false ? "notverified" : "unknown"}">Verification: ${verificationlabel}</span>
                    <span class="verificationdetail">Status: ${verificationstatus}</span>
                    <span class="verificationdetail">YSWS eligibility: ${eligibilitylabel}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="statsgrid viewasstats">
              <div class="stat">
                <p class="statlabel">Joined channels</p>
                <p class="statvalue">${joinedcount}</p>
              </div>
              <div class="stat">
                <p class="statlabel">Remaining</p>
                <p class="statvalue">${remainingcount}</p>
              </div>
              <div class="stat">
                <p class="statlabel">Total YSWSes</p>
                <p class="statvalue">${totalcount}</p>
              </div>
            </div>
            <div class="progresswrap" style="margin-top: 10px">
              <p class="statlabel" style="margin: 0">Completion</p>
              <p class="progressmeta">${completedcount} of ${totalcount} fully complete (${completionpercent}%)</p>
              <div class="progressbar">
                <div class="progressfill" style="width:${completionpercent}%"></div>
              </div>
            </div>
            <div class="grid viewasgrid">${cardshtml}</div>
          </div>
        `;

        if (actionmessage) {
          viewasmodalstatus.textContent = actionmessage;
          viewasmodalstatus.className = /Added|Marked|Removed|already in/i.test(actionmessage)
            ? "status success"
            : "status";
        }

        viewasmodalcontent.querySelectorAll(".viewasjoinbtn").forEach((button) => {
          button.addEventListener("click", () => {
            const channel = button.getAttribute("data-channel");
            const channelname = button.getAttribute("data-name");
            showpermissionprompt({
              question: `Did this user (${data.slackId}) give you permission to add them to ${channelname}?`,
              loadingtext: "Joining...",
              selector: `.viewasjoinbtn[data-channel="${channel}"]`,
              onconfirm: async () => {
                const response = await apifetch("/api/admin/test-join", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ slackId: data.slackId, channel }),
                });
                const joindata = await readjson(response, { ok: false });

                if (!joindata.ok) {
                  return `Could not add ${data.slackId} to ${channelname}: ${formatapierror(joindata, "failed")}`;
                }

                viewasstate.membership[channel] = true;
                return joindata.result === "already_in_channel"
                  ? `${data.slackId} is already in ${channelname}.`
                  : `Added ${data.slackId} to ${channelname}. ✓`;
              },
            });
          });
        });

        viewasmodalcontent.querySelectorAll(".viewasrsvpbtn").forEach((button) => {
          button.addEventListener("click", () => {
            const channel = button.getAttribute("data-channel");
            const channelname = button.getAttribute("data-name");
            const done = button.getAttribute("data-done") === "true";
            showpermissionprompt({
              question: done
                ? `Did this user (${data.slackId}) ask you to mark the ${channelname} RSVP as done?`
                : `Did this user (${data.slackId}) ask you to undo the ${channelname} RSVP done mark?`,
              loadingtext: done ? "Saving..." : "Undoing...",
              selector: `.viewasrsvpbtn[data-channel="${channel}"]`,
              onconfirm: async () => {
                const response = await apifetch("/api/admin/test-rsvp", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ slackId: data.slackId, channel, done }),
                });
                const rsvpdata = await readjson(response, { ok: false });

                if (!rsvpdata.ok) {
                  return `Could not ${done ? "mark" : "undo"} ${channelname}: ${formatapierror(rsvpdata, "failed")}`;
                }

                viewasstate.rsvpdone = { ...(viewasstate.rsvpdone || {}), ...(rsvpdata.rsvpDone || {}), [channel]: done };
                return done
                  ? `Marked ${channelname} RSVP as done for ${data.slackId}.`
                  : `Removed the RSVP done mark for ${channelname}.`;
              },
            });
          });
        });
      }

      function showpermissionprompt({ question, selector, loadingtext, onconfirm }) {
        (async () => {
          const result = await showconfirm({
            title: "Permission check",
            text: question,
            confirmbuttontext: "Yes, proceed",
            cancelbuttontext: "No, cancel",
          });
          if (!result?.isConfirmed) return;

          const button = selector ? viewasmodalcontent.querySelector(selector) : null;
          if (button) {
            button.disabled = true;
            if (button.classList.contains("rsvptoggle")) {
              button.classList.add("isloading");
            } else {
              button.textContent = loadingtext || "Working...";
            }
          }

          let message = "";
          try {
            message = await onconfirm();
          } catch (_err) {
            message = "Request failed while updating that user.";
          }

          renderviewasdashboard(message);
        })();
      }

      async function lookupuser() {
        const input = document.getElementById("lookupslackidinput");
        const resultbox = document.getElementById("lookupresult");
        const btn = document.getElementById("lookupbtn");
        const slackid = input.value.trim().toUpperCase();

        if (!slackid) {
          resultbox.innerHTML = `<span class="resulterr">Enter a Slack ID first.</span>`;
          return;
        }

        btn.disabled = true;
        resultbox.innerHTML = `<span style="color:var(--hcmuted)">Loading…</span>`;

        try {
          const response = await apiget(`/api/admin/lookup?slackId=${encodeURIComponent(slackid)}`);
          const data = await readjson(response, { ok: false });

          if (!data.ok) {
            resultbox.innerHTML = `<span class="resulterr">${formatapierror(data, "Lookup failed.")}</span>`;
            return;
          }

          const rows = [
            ["Name", data.name || "—"],
            ["Username", data.username ? `@${data.username}` : "—"],
            ["Slack ID", data.slackId || "—"],
          ];

          const rowshtml = rows
            .map(([label, value]) =>
              `<div class="resultrow"><span class="resultlabel">${label}</span><span class="resultvalue">${value}</span></div>`,
            )
            .join("");

          const chips = Object.entries(data.membership || {})
            .map(
              ([channel, inchannel]) =>
                `<span class="membershipchip ${inchannel ? "in" : "out"}">${inchannel ? "✓" : "○"} ${channel}</span>`,
            )
            .join("");

          resultbox.innerHTML = rowshtml + (chips ? `<div class="membershipgrid">${chips}</div>` : "");
        } catch (_err) {
          resultbox.innerHTML = `<span class="resulterr">Request failed.</span>`;
        } finally {
          btn.disabled = false;
        }
      }

      async function loadyswscatalog() {
        const response = await apiget("/ysws.json").catch(() => null);
        if (!response || !response.ok) {
          yswscatalog = [];
          return;
        }

        const list = await response.json().catch(() => []);
        yswscatalog = list
          .filter((item) => item?.name && item?.channel)
          .map((item) => ({
            name: String(item.name),
            channel: String(item.channel).toUpperCase(),
            form: String(item.form || ""),
          }));
      }

      async function populatechannelselect() {
        const select = document.getElementById("testjoinchannelselect");
        select.innerHTML = "";
        if (!yswscatalog.length) {
          await loadyswscatalog();
        }

        yswscatalog
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((item) => {
          if (!item.channel) return;
          const opt = document.createElement("option");
          opt.value = item.channel;
          opt.textContent = `${item.name} — ${item.channel}`;
          select.appendChild(opt);
          });
      }

      function selectallchannels() {
        const select = document.getElementById("testjoinchannelselect");
        for (const option of select.options) option.selected = true;
      }

      function clearselectedchannels() {
        const select = document.getElementById("testjoinchannelselect");
        for (const option of select.options) option.selected = false;
      }

      async function testjoin() {
        const slackidinput = document.getElementById("testjoinslackidinput");
        const channelselect = document.getElementById("testjoinchannelselect");
        const resultbox = document.getElementById("testjoinresult");
        const btn = document.getElementById("testjoinbtn");
        const slackid = slackidinput.value.trim().toUpperCase();
        const channels = Array.from(channelselect.selectedOptions).map((o) => o.value);

        if (!slackid) {
          resultbox.innerHTML = `<span class="resulterr">Enter a Slack ID.</span>`;
          return;
        }
        if (!channels.length) {
          resultbox.innerHTML = `<span class="resulterr">Select at least one channel.</span>`;
          return;
        }

        btn.disabled = true;
        resultbox.innerHTML = `<span style="color:var(--hcmuted)">Working…</span>`;

        const results = [];
        for (const channel of channels) {
          try {
            const response = await apifetch("/api/admin/test-join", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ slackId: slackid, channel }),
            });
            const data = await readjson(response, { ok: false });
            results.push({
              channel,
              ok: data.ok,
              result: data.result,
              message: data.ok ? data.message : formatapierror(data, "Failed"),
            });
          } catch (_err) {
            results.push({ channel, ok: false, message: "Request failed." });
          }
        }

        resultbox.innerHTML = results
          .map((r) =>
            r.ok
              ? `<div class="resultrow"><span class="resultlabel">${r.channel}</span><span class="resultok">✓ ${r.result === "already_in_channel" ? "Already in" : "Added"}</span></div>`
              : `<div class="resultrow"><span class="resultlabel">${r.channel}</span><span class="resulterr">✗ ${r.message || "Failed"}</span></div>`,
          )
          .join("");

        const successcount = results.filter((r) => r.ok).length;
        const totalcount = results.length;
        resultbox.innerHTML = `<div class="resultrow"><span class="resultlabel">Summary</span><span class="resultvalue">${successcount}/${totalcount} channel updates succeeded</span></div>` + resultbox.innerHTML;

        await loaddata();
        btn.disabled = false;
      }

      async function boot() {
        const accessres = await apiget("/api/admin/access").catch(() => null);
        if (!accessres || !accessres.ok) {
          rendernoaccess("not_authenticated");
          return;
        }
        const data = await readjson(accessres, { ok: false });
        if (!data.ok) {
          rendernoaccess(data.code || "admin_only");
          return;
        }

        adminpanel.style.display = "grid";
        adminnoaccess.style.display = "none";

        refreshbtn.addEventListener("click", loaddata);
        document.getElementById("clearauditbtn").addEventListener("click", clearauditlog);
        document.getElementById("clearerrorsbtn").addEventListener("click", clearerrorsbycode);

        document.getElementById("closeviewasbtn").addEventListener("click", () => {
          viewasmodal.style.display = "none";
          viewasmodalstatus.textContent = "";
        });

        document.getElementById("viewasbtn").addEventListener("click", viewas);
        document.getElementById("viewasslackidinput").addEventListener("keydown", (e) => {
          if (e.key === "Enter") viewas();
        });

        document.getElementById("lookupbtn").addEventListener("click", lookupuser);
        document.getElementById("lookupslackidinput").addEventListener("keydown", (e) => {
          if (e.key === "Enter") lookupuser();
        });

        document.getElementById("testjoinbtn").addEventListener("click", testjoin);
        document.getElementById("selectallchannelsbtn").addEventListener("click", selectallchannels);
        document.getElementById("clearchannelsbtn").addEventListener("click", clearselectedchannels);

        await loadyswscatalog();
        await populatechannelselect();
        await loaddata();
      }

      boot();
