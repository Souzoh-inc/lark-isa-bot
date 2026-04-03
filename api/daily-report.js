const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL || "https://open.larksuite.com/open-apis/bot/v2/hook/9e9906a0-bd84-4d6f-93a2-c29ae4f503fc";

// ============================================
// 入管庁デイリーレポート（改善版）
// - 大事なお知らせ + 更新情報を構造的に抽出
// - 登録支援機関への影響を明示
// - 週次リマインド機能
// ============================================

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ISABot/1.0)", "Accept-Language": "ja" },
  });
  return await res.text();
}

// --- 大事なお知らせ（index.html の dateList02）---
function parseImportantNotices(html) {
  const items = [];
  const regex = /<ul class="dateList02">[\s\S]*?<\/ul>/;
  const match = html.match(regex);
  if (!match) return items;
  const liRegex = /<li>[\s\S]*?<a href="([^"]*)"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>[\s\S]*?<\/li>/g;
  let m;
  while ((m = liRegex.exec(match[0])) !== null) {
    const href = m[1].startsWith("http") ? m[1] : "https://www.moj.go.jp" + m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (text) items.push({ text, href });
  }
  return items;
}

// --- 更新情報（newslist/index.html の日付付きリスト）---
function parseNewsItems(html) {
  const items = [];
  const liRegex = /<li>\s*<span class="date">([^<]*)<\/span>\s*<span class="cat[^"]*">([^<]*)<\/span>[\s\S]*?<a href="([^"]*)"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/g;
  let m;
  while ((m = liRegex.exec(html)) !== null) {
    const date = m[1].trim();
    const category = m[2].replace(/<[^>]+>/g, "").trim();
    const href = m[3].startsWith("http") ? m[3] : "https://www.moj.go.jp" + m[3];
    const text = m[4].replace(/<[^>]+>/g, "").trim();
    if (text) items.push({ date, category, text, href });
  }
  return items;
}

// --- 今日・直近の更新のみフィルタ ---
function filterRecentNews(items, daysBack = 1) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - daysBack);
  return items.filter(item => {
    const match = item.date.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!match) return false;
    const d = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    return d >= cutoff;
  });
}

// --- 週次リマインド（月曜に今週の重要情報を再掲）---
function getWeeklyReminders() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const day = now.getDay(); // 0=Sun, 1=Mon
  if (day !== 1) return null; // 月曜日のみ
  return [
    "【定期届出】特定技能の定期届出の提出期間中です（4/1〜5/31）。新様式・参考様式第3-6号を使用。届出主体が受入れ機関に変更されています。",
    "【登録支援機関の要件厳格化】2027年4月に向け、人員配置上限・常勤要件の準備を進めてください。",
    "【育成就労制度】2027年施行予定の育成就労制度について、最新情報をフォローしてください。",
  ];
}

// --- 登録支援機関への影響を判定 ---
function analyzeImpact(text) {
  const keywords = {
    high: ["登録支援機関", "特定技能", "定期届出", "届出", "支援計画", "支援委託", "受入れ機関"],
    medium: ["在留資格", "省令改正", "上陸基準", "入管法", "手数料", "改正"],
    info: ["プレスリリース", "統計", "報道", "採用", "パンフレット"],
  };
  const lowerText = text;
  for (const [level, words] of Object.entries(keywords)) {
    for (const w of words) {
      if (lowerText.includes(w)) return level;
    }
  }
  return "info";
}

function impactLabel(level) {
  if (level === "high") return "🔴 要対応";
  if (level === "medium") return "🟡 要確認";
  return "ℹ️ 参考情報";
}

function impactDescription(text) {
  if (text.includes("登録支援機関")) return "→ 登録支援機関の業務に直接影響します";
  if (text.includes("特定技能")) return "→ 特定技能制度に関する変更です。受入れ企業への周知が必要です";
  if (text.includes("定期届出")) return "→ 届出業務に影響します。様式・期限を確認してください";
  if (text.includes("省令改正") || text.includes("入管法")) return "→ 法令改正です。業務フローの見直しが必要な場合があります";
  if (text.includes("在留資格")) return "→ 在留資格関連の変更です。申請業務への影響を確認してください";
  if (text.includes("手数料")) return "→ 手数料改定です。クライアントへの案内が必要です";
  return "";
}

// --- Larkカードメッセージ構築 ---
function buildLarkCard(importantNotices, recentNews, weeklyReminders) {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
    timeZone: "Asia/Tokyo",
  });

  const elements = [];

  // --- 本日の概要 ---
  let summary = "**📅 " + today + "**\n\n";
  if (recentNews.length === 0) {
    summary += "本日の新規更新はありませんでした。";
  } else {
    summary += "本日の新規更新: **" + recentNews.length + "件**\n";
    const highItems = recentNews.filter(n => analyzeImpact(n.text) === "high");
    const medItems = recentNews.filter(n => analyzeImpact(n.text) === "medium");
    if (highItems.length > 0) summary += "🔴 要対応: " + highItems.length + "件　";
    if (medItems.length > 0) summary += "🟡 要確認: " + medItems.length + "件";
  }
  elements.push({ tag: "markdown", content: summary });
  elements.push({ tag: "hr" });

  // --- 大事なお知らせ ---
  let importantMd = "**🔔 大事なお知らせ（入管庁トップ掲載）**\n\n";
  for (const item of importantNotices.slice(0, 7)) {
    const impact = analyzeImpact(item.text);
    importantMd += impactLabel(impact) + " [" + item.text + "](" + item.href + ")\n";
    const desc = impactDescription(item.text);
    if (desc) importantMd += desc + "\n";
    importantMd += "\n";
  }
  elements.push({ tag: "markdown", content: importantMd });
  elements.push({ tag: "hr" });

  // --- 更新情報（直近）---
  if (recentNews.length > 0) {
    let newsMd = "**📰 直近の更新情報**\n\n";
    for (const item of recentNews.slice(0, 8)) {
      const impact = analyzeImpact(item.text);
      newsMd += impactLabel(impact) + " **" + item.date + "** [" + item.category + "]\n";
      newsMd += "[" + item.text + "](" + item.href + ")\n";
      const desc = impactDescription(item.text);
      if (desc) newsMd += desc + "\n";
      newsMd += "\n";
    }
    elements.push({ tag: "markdown", content: newsMd });
    elements.push({ tag: "hr" });
  }

  // --- 週次リマインド（月曜のみ）---
  if (weeklyReminders) {
    let reminderMd = "**🔁 今週のリマインド（重要事項）**\n\n";
    for (const r of weeklyReminders) {
      reminderMd += "• " + r + "\n\n";
    }
    elements.push({ tag: "markdown", content: reminderMd });
    elements.push({ tag: "hr" });
  }

  // --- 登録支援機関への影響まとめ ---
  let impactMd = "**📋 登録支援機関への影響まとめ**\n\n";
  const allItems = [...importantNotices, ...recentNews];
  const highImpactItems = allItems.filter(i => analyzeImpact(i.text) === "high");
  const medImpactItems = allItems.filter(i => analyzeImpact(i.text) === "medium");
  if (highImpactItems.length > 0) {
    impactMd += "**【要対応】**\n";
    for (const item of highImpactItems.slice(0, 5)) {
      impactMd += "• " + item.text + "\n";
    }
    impactMd += "\n";
  }
  if (medImpactItems.length > 0) {
    impactMd += "**【要確認】**\n";
    for (const item of medImpactItems.slice(0, 5)) {
      impactMd += "• " + item.text + "\n";
    }
    impactMd += "\n";
  }
  if (highImpactItems.length === 0 && medImpactItems.length === 0) {
    impactMd += "本日は登録支援機関に直接影響のある更新はありませんでした。\n";
  }
  elements.push({ tag: "markdown", content: impactMd });

  // --- フッター ---
  elements.push({
    tag: "note",
    elements: [{
      tag: "plain_text",
      content: "出典: 出入国在留管理庁 (www.moj.go.jp/isa/) | 自動配信レポート"
    }]
  });

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "入管庁デイリーレポート - " + today },
        template: "blue",
      },
      elements,
    },
  };
}

async function sendToLark(message) {
  const res = await fetch(LARK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  return await res.json();
}

export default async function handler(req, res) {
  try {
    console.log("Daily report v2: starting...");

    // 1. 入管庁トップページから「大事なお知らせ」を取得
    const indexHtml = await fetchHTML("https://www.moj.go.jp/isa/index.html");
    const importantNotices = parseImportantNotices(indexHtml);
    console.log("Important notices:", importantNotices.length);

    // 2. 更新情報ページから最新ニュースを取得
    const newsHtml = await fetchHTML("https://www.moj.go.jp/isa/publications/newslist/index.html");
    const allNews = parseNewsItems(newsHtml);
    console.log("All news items:", allNews.length);

    // 3. 直近の更新をフィルタ（過去2日分）
    const recentNews = filterRecentNews(allNews, 2);
    console.log("Recent news:", recentNews.length);

    // 4. 週次リマインド（月曜のみ）
    const weeklyReminders = getWeeklyReminders();

    // 5. カードメッセージ構築＆送信
    const message = buildLarkCard(importantNotices, recentNews, weeklyReminders);
    const result = await sendToLark(message);
    console.log("Sent to Lark:", JSON.stringify(result));

    return res.status(200).json({
      ok: true,
      lark: result,
      stats: {
        importantNotices: importantNotices.length,
        recentNews: recentNews.length,
        hasWeeklyReminder: !!weeklyReminders,
      }
    });
  } catch (error) {
    console.error("Daily report error:", error);
    return res.status(500).json({ error: error.message });
  }
}
