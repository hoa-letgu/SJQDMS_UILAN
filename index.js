/**
 * Copy bảng từ SSMS/Excel/Notepad (TAB-separated).
 *
 * Hỗ trợ 2 kiểu input:
 * 1) 4 cột: ui_code   ui_cn   ui_yn   ui_en
 * 2) SSMS grid 5 cột (có header): ui_code ui_cn ui_en ui_yn ui_tittle
 *
 * Có REVIEW trước khi update + bắt xác nhận.
 * Chạy TEST trước, hỏi lại mới chạy PROD.
 *
 * Cài:
 *   npm i mssql clipboardy
 *
 * Chạy:
 *   node update_ui_lang_from_clipboard.js
 */

const sql = require("mssql");
const fs = require("fs");
const path = require("path");
const clipboardy = require("clipboardy").default;

const readline = require("readline");

const UI_TITTLE = "F_WMS_GroupMemberRelation";

/* =========================
 * DB LIST
 * ========================= */
const DB_LIST = [
  {
    name: "TEST",
    config: {
      user: "wiki",
      password: "Aa123456",
      server: "10.30.1.193",
      database: "SJEMSSYS",
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
    },
  },
  {
    name: "PROD",
    config: {
      user: "sa",
      password: "Aph.srv.pwd",
      server: "10.30.0.37",
      database: "SJEMSSYS",
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
    },
  },
];

/* =========================
 * ASK / CONFIRM
 * ========================= */
function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve((ans || "").trim());
    })
  );
}

function previewRows(rows, limit = 15) {
  console.log(
    "\n========== PREVIEW (first " +
      Math.min(limit, rows.length) +
      " rows) =========="
  );
  rows.slice(0, limit).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2, "0")}. ` +
        `ui_code=${JSON.stringify(r.ui_code)} | ` +
        `ui_cn=${JSON.stringify(r.ui_cn)} | ` +
        `ui_en=${JSON.stringify(r.ui_en)} | ` +
        `ui_yn=${JSON.stringify(r.ui_yn)} | ` +
        `ui_tittle=${JSON.stringify(r.ui_tittle)} | ` +
        `ui_id=${JSON.stringify(r.ui_id)}`
    );
  });
  console.log(
    "================================================================\n"
  );
}

/* =========================
 * PARSE CLIPBOARD
 * - Detect header if present (SSMS grid copy)
 * - Map columns by name: ui_code/ui_cn/ui_en/ui_yn
 * - Convert "NULL" => "" (empty string)
 * ========================= */
function parseUiClipboardFixed6(raw) {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];
  const errors = [];

  const splitCols = (line) => line.split("\t").map((c) => c.trim());

  const norm = (v) => {
    if (v == null) return "";
    const s = String(v).trim();
    if (s.toUpperCase() === "NULL") return "";
    return s;
  };

  // Nếu dòng đầu là header thì bỏ qua
  let startIdx = 0;
  const first = splitCols(lines[0] || "").map((x) => x.toLowerCase());
  const isHeader =
    first[0] === "ui_code" &&
    first.includes("ui_tittle") &&
    first.includes("ui_id");
  if (isHeader) startIdx = 1;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const cols = splitCols(line);

    if (cols.length < 6) {
      errors.push({ line: i + 1, reason: "Need 6 columns", text: line });
      continue;
    }

    const ui_code = norm(cols[0]);
    const ui_cn = norm(cols[1]);
    const ui_en = norm(cols[2]);
    const ui_yn = norm(cols[3]);
    const ui_tittle = norm(cols[4]);
    const ui_id = norm(cols[5]);

    if (!ui_code) {
      errors.push({ line: i + 1, reason: "ui_code empty", text: line });
      continue;
    }
    if (!ui_tittle || !ui_id) {
      errors.push({ line: i + 1, reason: "ui_tittle/ui_id empty", text: line });
      continue;
    }

    rows.push({ ui_code, ui_cn, ui_en, ui_yn, ui_tittle, ui_id });
  }

  return { rows, errors };
}

/* =========================
 * BACKUP JSON (THEO DB)
 * ========================= */
function saveBackupJson(dbName, backupObj, titles) {
  if (!backupObj || Object.keys(backupObj).length === 0) return;

  const dir = path.join(__dirname, "ui_language_backup", dbName);
  fs.mkdirSync(dir, { recursive: true });

  // nếu 1 title -> dùng title đó, nếu nhiều -> MULTI_TITTLE
  const safeTitle = (titles.length === 1 ? titles[0] : "MULTI_TITTLE").replace(
    /[<>:"/\\|?*]+/g,
    "_"
  );

  const filePath = path.join(dir, `${safeTitle}_${dbName}.json`);

  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        ui_tittle: titles.length === 1 ? titles[0] : titles,
        database: dbName,
        exported_at: new Date().toISOString(),
        data: backupObj,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`📄 Backup saved → ${filePath}`);
}

/* =========================
 * UPDATE ONE DATABASE
 * - Không ghi đè rỗng: nếu en/yn/cn đều rỗng thì skip
 * ========================= */
async function updateOneDB(dbName, dbConfig, rows) {
  console.log(`\n🚀 START UPDATE → ${dbName}`);

  let pool;
  const backupData = {};

  // lấy danh sách ui_tittle trong clipboard
  const titles = [...new Set(rows.map((r) => r.ui_tittle).filter(Boolean))];

  try {
    pool = await sql.connect(dbConfig);
    console.log(`✅ Connected to ${dbName}`);

    const sqlText = `
      UPDATE SJQDMS_UILAN
      SET ui_cn = @ui_cn,
          ui_yn = @ui_yn,
          ui_en = @ui_en
      WHERE ui_tittle = @ui_tittle
        AND ui_code   = @ui_code
        AND ui_id     = @ui_id
    `;

    let ok = 0;
    let miss = 0;
    let skipped = 0;

    for (const r of rows) {
      // không ghi đè rỗng
      if (!r.ui_cn && !r.ui_yn && !r.ui_en) {
        skipped++;
        continue;
      }

      const req = pool.request();
      req.input("ui_cn", sql.NVarChar, r.ui_cn);
      req.input("ui_yn", sql.NVarChar, r.ui_yn);
      req.input("ui_en", sql.NVarChar, r.ui_en);
      req.input("ui_tittle", sql.NVarChar, r.ui_tittle);
      req.input("ui_code", sql.NVarChar, r.ui_code);
      req.input("ui_id", sql.NVarChar, r.ui_id);

      const result = await req.query(sqlText);

      if (result.rowsAffected?.[0] > 0) {
        ok++;

        // ✅ key unique tránh ghi đè (ui_code trùng)
        const key = `${r.ui_code}|${r.ui_id}`;
        backupData[key] = {
          ui_code: r.ui_code,
          ui_id: r.ui_id,
          ui_tittle: r.ui_tittle,
          cn: r.ui_cn,
          en: r.ui_en,
          yn: r.ui_yn,
        };

        console.log(`[${dbName}] ✔️ ${r.ui_code} | ${r.ui_id}`);
      } else {
        miss++;
        console.log(`[${dbName}] ⚠️ Not found → ${r.ui_code} | ${r.ui_id}`);
      }
    }

    console.log(
      `📌 ${dbName} summary: updated=${ok}, not_found=${miss}, skipped_empty=${skipped}`
    );

    // ✅ truyền titles để đặt tên file + metadata đúng
    saveBackupJson(dbName, backupData, titles);
  } catch (err) {
    console.error(`❌ ERROR (${dbName}):`, err);
  } finally {
    try {
      await sql.close();
    } catch {}
  }
}

/* =========================
 * RUN
 * ========================= */
(async function run() {
  // 1) Read clipboard
  const raw = clipboardy.readSync();

  if (!raw || !raw.trim()) {
    console.log("❌ Clipboard is empty. Hãy copy dữ liệu trước rồi chạy lại.");
    return;
  }

  // 2) Parse
  const { rows, errors } = parseUiClipboardFixed6(raw);

  console.log(`📥 Clipboard rows parsed: ${rows.length}`);
  if (errors.length > 0) {
    console.log(`⚠️ Parse errors: ${errors.length}`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  - line ${e.line}: ${e.reason} | ${e.text}`);
    }
  }

  if (rows.length === 0) {
    console.log("❌ No valid rows to update.");
    return;
  }

  // 3) Review
  previewRows(rows, 10);

  // 4) Confirm overall
  const titles = [...new Set(rows.map((r) => r.ui_tittle).filter(Boolean))];
  const titleText = titles.length === 1 ? titles[0] : titles.join(", ");
  const ans = await ask(
    `Continue update ${rows.length} rows for ui_tittle=[${titleText}] ? (y/N): `
  );

  if (ans.toLowerCase() !== "y") {
    console.log("⛔ Cancelled.");
    return;
  }

  // 5) Run TEST then PROD (confirm before PROD)
  const testDb = DB_LIST.find((d) => d.name === "TEST");
  const prodDb = DB_LIST.find((d) => d.name === "PROD");

  if (testDb) {
    await updateOneDB(testDb.name, testDb.config, rows);
  }

  if (prodDb) {
    const ans2 = await ask("✅ TEST done. Continue update PROD? (y/N): ");
    if (ans2.toLowerCase() !== "y") {
      console.log("⛔ Stopped before PROD.");
      return;
    }
    await updateOneDB(prodDb.name, prodDb.config, rows);
  }

  console.log("\n🎉 ALL DATABASES UPDATED");
})();
