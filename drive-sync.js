const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const APP_KEY = "url-drawer-sync-v1";

const keyFor = ({ category, url }) => JSON.stringify([category, url]);
const sorted = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareRegisters = (a, b) => a.clock - b.clock || sorted(a.device, b.device);

function rowContents(row) {
  if (!row) return null;
  const { id, category, number, url, memo, productUrl, memoEdited } = row;
  return [id, category, number, url, memo, productUrl, memoEdited];
}

export function changedRows(previous, current) {
  const old = new Map(previous.map((row) => [keyFor(row), row]));
  const next = new Map(current.map((row) => [keyFor(row), row]));
  const edits = new Map();
  for (const [key, row] of next) {
    if (JSON.stringify(rowContents(row)) !== JSON.stringify(rowContents(old.get(key)))) edits.set(key, row);
  }
  for (const key of old.keys()) {
    if (!next.has(key)) edits.set(key, null);
  }
  return edits;
}

function maxNumbers(...sources) {
  const next = Object.create(null);
  for (const source of sources) {
    for (const [category, number] of Object.entries(source ?? {})) {
      if (Number.isSafeInteger(number) && number >= 0) next[category] = Math.max(next[category] ?? 0, number);
    }
  }
  return next;
}

function numberRows(rows, counters) {
  const numbers = maxNumbers(counters);
  const seen = new Set();
  for (const row of rows) numbers[row.category] = Math.max(numbers[row.category] ?? 0, row.number);
  const links = rows.map((row) => {
    const original = JSON.stringify([row.category, row.number]);
    if (!seen.has(original)) {
      seen.add(original);
      return row;
    }
    const number = ++numbers[row.category];
    seen.add(JSON.stringify([row.category, number]));
    return { ...row, number };
  });
  return { links, numbers };
}

export function mergeReplicas(replicas) {
  const records = new Map();
  let clock = 0;
  for (const replica of replicas) {
    for (const [id, record] of Object.entries(replica.records)) {
      const existing = records.get(id);
      if (!existing || compareRegisters(record, existing) > 0) records.set(id, record);
      clock = Math.max(clock, record.clock);
    }
  }
  const newest = [...records.values()].sort((a, b) =>
    compareRegisters(b, a) || sorted(a.row?.id ?? "", b.row?.id ?? ""));
  const rows = [...new Map(newest.filter(({ row }) => row).reverse()
    .map(({ row }) => [keyFor(row), row])).values()].reverse();
  return { ...numberRows(rows, maxNumbers(...replicas.map((replica) => replica.numbers))), clock };
}

export function overlayBrowserEdits(before, current, cloud) {
  const edits = changedRows(before.links, current.links);
  const rows = new Map(cloud.links.map((row) => [keyFor(row), row]));
  const edited = [];
  for (const [key, row] of edits) {
    rows.delete(key);
    if (row) edited.push(row);
  }
  return {
    ...numberRows([...edited, ...rows.values()], maxNumbers(current.numbers, cloud.numbers)),
    pending: edits.size > 0,
  };
}

async function recordKey(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class DriveError extends Error {
  constructor(status) {
    super("Google Drive HTTP " + status);
    this.status = status;
  }
}

export function createDriveSync({ clientId, read, apply, show }) {
  let token = "";
  let expiresAt = 0;
  let busy = false;
  let timer;
  let authorizing = false;

  async function request(url, options = {}, accessToken = token) {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: "Bearer " + accessToken },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new DriveError(response.status);
    return response.json();
  }

  async function listReplicas() {
    const files = [];
    let pageToken;
    do {
      const query = new URLSearchParams({
        spaces: "appDataFolder",
        q: "appProperties has { key='app' and value='" + APP_KEY + "' }",
        fields: "nextPageToken,files(id,appProperties)",
        pageSize: "100",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const page = await request(DRIVE + "/files?" + query);
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return Promise.all(files.map((file) => readReplica(file.id, file.appProperties?.device)));
  }

  async function readReplica(fileId, device) {
    const replica = await request(DRIVE + "/files/" + encodeURIComponent(fileId) + "?alt=media");
    if (replica.version !== 1 || replica.device !== device ||
        !replica.records || Array.isArray(replica.records)) throw new Error("Invalid sync file");
    return { ...replica, fileId };
  }

  async function writeReplica(data, fileId) {
    if (fileId) {
      const result = await request(UPLOAD + "/files/" + encodeURIComponent(fileId) + "?uploadType=media&fields=id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(data),
      });
      return result.id;
    }
    const boundary = "url_drawer_" + crypto.randomUUID();
    const metadata = {
      name: "link-drawer-" + data.device + ".json",
      parents: ["appDataFolder"],
      mimeType: "application/json",
      appProperties: { app: APP_KEY, device: data.device },
    };
    const body = [metadata, data].map((part) =>
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(part) + "\r\n"
    ).join("") + "--" + boundary + "--\r\n";
    const result = await request(UPLOAD + "/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + boundary },
      body,
    });
    return result.id;
  }

  async function perform() {
    const start = read();
    const settings = start.driveSync;
    const replicas = await listReplicas();
    let own = replicas.find((replica) => replica.device === settings.device);
    if (!own && settings.fileId) {
      own = await readReplica(settings.fileId, settings.device);
      replicas.push(own);
    }
    if (!replicas.length && settings.baseline?.length) throw new Error("Missing sync data");
    let fileId = own?.fileId;
    const edits = changedRows(settings.baseline ?? [], start.links);
    if (edits.size) {
      const current = mergeReplicas(replicas);
      const records = { ...own?.records };
      let clock = Math.max(Date.now(), current.clock + 1);
      for (const [key, row] of [...edits].reverse()) {
        records[await recordKey(key)] = { row, clock: clock++, device: settings.device };
      }
      const update = {
        version: 1,
        device: settings.device,
        records,
        numbers: maxNumbers(own?.numbers, start.numbers),
      };
      fileId = await writeReplica(update, fileId);
      if (!fileId) throw new Error("Missing Drive file ID");
      if (own) replicas.splice(replicas.indexOf(own), 1, update);
      else replicas.push(update);
    }
    const cloud = mergeReplicas(replicas);
    const current = read();
    const next = overlayBrowserEdits(start, current, cloud);
    if (!apply({
      ...current,
      links: next.links,
      numbers: next.numbers,
      driveSync: { ...settings, fileId, baseline: cloud.links, lastSync: Date.now() },
    })) throw new Error("Local save failed");
    show("connected", "동기화 완료 · " + new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit", minute: "2-digit",
    }).format(new Date()));
    if (next.pending) queue();
  }

  function showError(error) {
    if (error.status === 401) {
      token = "";
      show("reconnect", "동기화를 누르면 Google 연결을 갱신해요.");
    } else if (error.status === 403) {
      show("retry", "Google Drive 권한을 확인하지 못했어요. 다시 연결해 주세요.");
      token = "";
    } else {
      show("retry", "동기화가 잠시 중단됐어요. 이 브라우저에 저장한 내용은 남아 있어요.");
    }
  }

  async function sync() {
    if (!token || busy) return;
    if (Date.now() >= expiresAt) {
      token = "";
      show("reconnect", "동기화를 누르면 Google 연결을 갱신해요.");
      return;
    }
    busy = true;
    show("working", "Google Drive와 동기화 중…");
    try {
      if (navigator.locks) await navigator.locks.request(APP_KEY, perform);
      else await perform();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  function queue() {
    if (!token) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy) queue();
      else void sync();
    }, 550);
  }

  async function authorize(response) {
    authorizing = false;
    if (!response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE)) {
      show("reconnect", "Google Drive 연결이 완료되지 않았어요.");
      return;
    }
    try {
      const fields = new URLSearchParams({ fields: "user(permissionId,emailAddress)" });
      const { user } = await request(DRIVE + "/about?" + fields, {}, response.access_token);
      const current = read();
      const existing = current.driveSync;
      if (!user?.permissionId) throw new Error("Missing Drive account");
      if (existing?.account && existing.account !== user.permissionId) {
        token = "";
        show("reconnect", "이전에 연결한 Google 계정으로 다시 연결해 주세요.");
        return;
      }
      const settings = existing ?? { account: user.permissionId, device: crypto.randomUUID(), baseline: [] };
      const loginHint = user.emailAddress || settings.loginHint;
      if ((!existing || loginHint !== existing.loginHint) && !apply({
        ...current, driveSync: { ...settings, loginHint },
      })) throw new Error("Local save failed");
      token = response.access_token;
      expiresAt = Date.now() + Math.max(0, Number(response.expires_in) - 30) * 1000;
      await sync();
    } catch (error) {
      token = "";
      showError(error);
    }
  }

  function connectOrSync() {
    if (token && Date.now() < expiresAt) {
      void sync();
      return;
    }
    if (authorizing) return;
    if (!clientId || !window.google?.accounts?.oauth2) {
      show("reconnect", "Google 연결을 불러오는 중이에요. 잠시 후 다시 눌러 주세요.");
      return;
    }
    try {
      const settings = read().driveSync;
      authorizing = true;
      show("working", "Google 연결을 확인하는 중…");
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        include_granted_scopes: false,
        prompt: settings?.account ? "" : "select_account",
        ...(settings?.loginHint ? { login_hint: settings.loginHint } : {}),
        callback: authorize,
        error_callback: () => {
          authorizing = false;
          show("reconnect", "Google 연결 창이 닫혔어요. 다시 연결할 수 있어요.");
        },
      });
      client.requestAccessToken();
    } catch {
      authorizing = false;
      show("reconnect", "Google 연결 창을 열지 못했어요. 다시 눌러 주세요.");
    }
  }

  function start() {
    if (read().driveSync?.account) {
      show("ready", "동기화를 누르면 연결한 Google 계정에서 최신 목록을 불러와요.");
    } else {
      show("idle", "링크를 Google Drive에 저장하고 같은 계정으로 두 기기에서 볼 수 있어요.");
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && token) void sync();
    });
    setInterval(() => {
      if (!document.hidden && token) void sync();
    }, 60000);
  }

  return { start, connectOrSync, queue };
}
