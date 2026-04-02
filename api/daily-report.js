const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL || "https://open.larksuite.com/open-apis/bot/v2/hook/9e9906a0-bd84-4d6f-93a2-c29ae4f503fc";

async function fetchISAPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ISABot/1.0)", "Accept-Language": "ja" },
    });
    const html = await res.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
  } catch (e) {
    return "Error: " + e.message;
  }
}

async function gatherISANews() {
  const pages = [
    { url: "https://www.moj.go.jp/isa/index.html", label: "トップページ" },
    { url: "https://www.moj.go.jp/isa/applications/ssw/index.html", label: "特定技能制度" },
    { url: "https://www.moj.go.jp/isa/01_00461.html", label: "令和6年入管法改正" },
    { url: "https://www.moj.go.jp/isa/10_00222.html", label: "令和7年4月施行の省令改正" },
  ];
  const results = await Promise.all(
    pages.map(async (p) => {
      const text = await fetchISAPage(p.url);
      return "\n---- " + p.label + " (" + p.url + ") ----\n" + text;
    })
  );
  return results.join("\n");
}

function summarizeISAContent(isaText) {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Tokyo",
  });
  const s = [];
  s.push("**" + today + " の入管庁情報まとめ**\n");
  if (isaText.includes("特定技能") || isaText.includes("定期届出")) {
    s.push("**【特定技能関連】**");
    if (isaText.includes("定期届出")) s.push("・定期届出に関する情報が掲載されています。届出期間・様式をご確認ください。");
    if (isaText.includes("登録支援機関")) s.push("・登録支援機関に関する更新情報があります。");
    if (isaText.includes("分野")) s.push("・特定技能の対象分野に関する情報が確認できます。");
    s.push("");
  }
  if (isaText.includes("改正") || isaText.includes("省令") || isaText.includes("施行")) {
    s.push("**【法令改正関連】**");
    if (isaText.includes("令和7年") || isaText.includes("2025年")) s.push("・令和7年施行の改正情報が掲載されています。");
    if (isaText.includes("育成就労")) s.push("・育成就労制度に関する情報があります。");
    s.push("");
  }
  if (isaText.includes("お知らせ") || isaText.includes("新着") || isaText.includes("プレスリリース")) {
    s.push("**【お知らせ・新着情報】**");
    s.push("・入管庁サイトに新着情報が掲載されています。詳細は公式サイトをご確認ください。");
    s.push("");
  }
  s.push("**【確認推奨リンク】**");
  s.push("・[入管庁トップ](https://www.moj.go.jp/isa/index.html)");
  s.push("・[特定技能制度](https://www.moj.go.jp/isa/applications/ssw/index.html)");
  s.push("・[省令改正](https://www.moj.go.jp/isa/10_00222.html)");
  return s.join("\n");
}

function buildLarkMessage(reportText) {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Tokyo",
  });
  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "入管庁デイリーレポート - " + today },
        template: "blue",
      },
      elements: [
        { tag: "markdown", content: reportText.slice(0, 2800) },
        { tag: "note", elements: [{ tag: "plain_text", content: "出典: 出入国在留管理庁公式サイト (www.moj.go.jp/isa/)" }] },
      ],
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
    console.log("Daily report: starting...");
    const isaContext = await gatherISANews();
    const summary = summarizeISAContent(isaContext);
    const message = buildLarkMessage(summary);
    const result = await sendToLark(message);
    console.log("Daily report: sent to Lark", JSON.stringify(result));
    return res.status(200).json({ ok: true, lark: result });
  } catch (error) {
    console.error("Daily report error:", error);
    return res.status(500).json({ error: error.message });
  }
}
