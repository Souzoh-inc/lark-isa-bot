const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL || "https://open.larksuite.com/open-apis/bot/v2/hook/9e9906a0-bd84-4d6f-93a2-c29ae4f503fc";

// ============================================
// 入管庁デイリーレポート v3
// ============================================

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ISABot/1.0)", "Accept-Language": "ja" },
  });
  return await res.text();
}

// welタグ等を除去してプレーンHTMLに変換
function stripWelTags(html) {
  return html.replace(/<wel[^>]*>/gi, "").replace(/<\/wel>/gi, "");
}

// --- 大事なお知らせ（index.html）---
function parseImportantNotices(rawHtml) {
  const html = stripWelTags(rawHtml);
  const items = [];
  // dateList02 内の li > div.txt > a を取得
  const sectionMatch = html.match(/<ul class="dateList02">[\s\S]*?<\/ul>/);
  if (!sectionMatch) { console.log("No dateList02 found"); return items; }
  const block = sectionMatch[0];
  const linkRegex = /<a\s+href="([^"]*)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = linkRegex.exec(block)) !== null) {
    const href = m[1].startsWith("http") ? m[1] : "https://www.moj.go.jp" + m[1];
    const text = m[2].trim();
    if (text) items.push({ text, href });
  }
  return items;
}

// --- 更新情報（newslist/index.html）---
function parseNewsItems(rawHtml) {
  const html = stripWelTags(rawHtml);
  const items = [];
  // パターン: <li>...<span class="date">日付</span>...<span class="catXX">カテゴリ</span>...<a href="URL">テキスト</a>...</li>
  const liRegex = /<li>[\s\S]*?<\/li>/g;
  let liMatch;
  while ((liMatch = liRegex.exec(html)) !== null) {
    const li = liMatch[0];
    const dateMatch = li.match(/<span class="date">([^<]*)<\/span>/);
    const catMatch = li.match(/<span class="cat[^"]*">([^<]*)<\/span>/);
    const linkMatch = li.match(/<a\s+href="([^"]*)"[^>]*>([^<]+)<\/a>/);
    if (dateMatch && linkMatch) {
      const date = dateMatch[1].trim();
      const category = catMatch ? catMatch[1].trim() : "";
      const href = linkMatch[1].startsWith("http") ? linkMatch[1] : "https://www.moj.go.jp" + linkMatch[1];
      const text = linkMatch[2].trim();
      items.push({ date, category, text, href });
    }
  }
  return items;
}

// --- 直近フィルタ ---
function filterRecentNews(items, daysBack = 2) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - daysBack);
  cutoff.setHours(0, 0, 0, 0);
  return items.filter(item => {
    const m = item.date.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!m) return false;
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    return d >= cutoff;
  });
}

// --- 登録支援機関への影響判定 ---
function analyzeImpact(text) {
  const high = ["登録支援機関", "特定技能", "定期届出", "届出", "支援計画", "支援委託", "受入れ機関"];
  const med = ["在留資格", "省令改正", "上陸基準", "入管法", "手数料", "改正", "在留手続"];
  for (const w of high) { if (text.includes(w)) return "high"; }
  for (const w of med) { if (text.includes(w)) return "medium"; }
  return "info";
}

// --- Larkカード構築（添付画像1の形式に準拠）---
function buildLarkCard(importantNotices, recentNews, allNews) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  const dateStr = now.getFullYear() + "年" + (now.getMonth() + 1) + "月" + now.getDate() + "日・" + weekday;
  const isMonday = now.getDay() === 1;

  const elements = [];

  // === 新着情報セクション ===
  let newsMd = "**🆕 新着情報（直近2日）**\n\n";
  if (recentNews.length === 0) {
    newsMd += "直近2日間の新規掲載はありませんでした。\n";
    // 代わりに最新5件を表示
    if (allNews.length > 0) {
      newsMd += "\n**最新の更新情報:**\n";
      for (const item of allNews.slice(0, 5)) {
        newsMd += "**【" + item.date.replace(/^\d{4}年/, "") + "】** " + item.text + "\n";
        newsMd += "→ " + item.category + " | [詳細](" + item.href + ")\n\n";
      }
    }
  } else {
    for (const item of recentNews) {
      const dateShort = item.date.replace(/^\d{4}年/, "");
      newsMd += "**【" + dateShort + "】** " + item.text + "\n";
      // 登録支援機関への影響コメント
      const impact = analyzeImpact(item.text);
      if (impact === "high") {
        newsMd += "→ 登録支援機関の業務に直接影響。詳細を必ず確認してください。\n";
      } else if (impact === "medium") {
        newsMd += "→ 在留手続・制度変更に関連。申請業務への影響を確認してください。\n";
      } else {
        newsMd += "→ " + item.category + "\n";
      }
      newsMd += "[詳細を見る](" + item.href + ")\n\n";
    }
  }
  elements.push({ tag: "markdown", content: newsMd });
  elements.push({ tag: "hr" });

  // === 登録支援機関への影響 ===
  let impactMd = "**🟢 登録支援機関への影響**\n\n";
  const allItems = [...recentNews, ...importantNotices];
  const highItems = allItems.filter(i => analyzeImpact(i.text) === "high");
  const medItems = allItems.filter(i => analyzeImpact(i.text) === "medium");

  if (highItems.length > 0) {
    impactMd += "🔴 **やるべきこと（法的義務）：**\n";
    for (const item of highItems) {
      impactMd += "・" + item.text + "\n";
    }
    impactMd += "\n";
  } else {
    impactMd += "🔴 **やるべきこと（法的義務）：** なし\n\n";
  }

  if (medItems.length > 0) {
    impactMd += "🟡 **やらないといけないこと（届出・手続き）：**\n";
    for (const item of medItems) {
      impactMd += "・" + item.text + "\n";
    }
    impactMd += "\n";
  } else {
    impactMd += "🟡 **やらないといけないこと（届出・手続き）：** なし\n\n";
  }

  impactMd += "🟢 **気をつけること：** 入管庁の新着情報を定期フォロー\n";
  elements.push({ tag: "markdown", content: impactMd });
  elements.push({ tag: "hr" });

  // === リマインド：重要な既存事項（毎回表示、月曜は強調）===
  let reminderMd = "**⚠️ リマインド：重要な既存事項**\n\n";
  reminderMd += "・**2025年4月施行済** — 定期届出が年1回に変更済。協力確認書の提出必要。対応済みか再確認を！\n";
  reminderMd += "・**2027年4月施行予定** — 要件厳格化（担当者1人あたり外国人50名・企業10社上限、常勤、講習修了要件）\n";
  reminderMd += "・**特定技能ページ最終更新** — 定期届出作成要領を確認してください\n";
  if (isMonday) {
    reminderMd += "\n📌 **今週の注意:** 今週中に定期届出の進捗確認・クライアント企業への周知状況を確認しましょう。\n";
  }
  elements.push({ tag: "markdown", content: reminderMd });
  elements.push({ tag: "hr" });

  // === クイックリンク ===
  let linksMd = "🔗 [入管庁トップ](https://www.moj.go.jp/isa/index.html)｜";
  linksMd += "[特定技能制度](https://www.moj.go.jp/isa/applications/ssw/index.html)｜";
  linksMd += "[省令改正](https://www.moj.go.jp/isa/10_00222.html)｜";
  linksMd += "[更新情報一覧](https://www.moj.go.jp/isa/publications/newslist/index.html)";
  elements.push({ tag: "markdown", content: linksMd });

  // === フッター ===
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: "出典: 出入国在留管理庁公式サイト (www.moj.go.jp/isa/) | 自動配信レポート" }]
  });

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "入管庁ニュース（" + dateStr + "）" },
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
    console.log("Daily report v3: starting...");

    const indexHtml = await fetchHTML("https://www.moj.go.jp/isa/index.html");
    const importantNotices = parseImportantNotices(indexHtml);
    console.log("Important notices:", importantNotices.length);

    const newsHtml = await fetchHTML("https://www.moj.go.jp/isa/publications/newslist/index.html");
    const allNews = parseNewsItems(newsHtml);
    console.log("All news items:", allNews.length);

    const recentNews = filterRecentNews(allNews, 2);
    console.log("Recent news:", recentNews.length);

    const message = buildLarkCard(importantNotices, recentNews, allNews);
    const result = await sendToLark(message);
    console.log("Sent to Lark:", JSON.stringify(result));

    return res.status(200).json({
      ok: true, lark: result,
      stats: { importantNotices: importantNotices.length, allNews: allNews.length, recentNews: recentNews.length }
    });
  } catch (error) {
    console.error("Daily report error:", error);
    return res.status(500).json({ error: error.message });
  }
}
