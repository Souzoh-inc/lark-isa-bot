import Anthropic from "@anthropic-ai/sdk";

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
  ANTHROPIC_API_KEY,
  LARK_BOT_NAME = "入管庁ボット",
} = process.env;

async function getLarkAccessToken() {
  const res = await fetch(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
    }
  );
  const data = await res.json();
  return data.tenant_access_token;
}

async function sendLarkReply(chatId, content, msgType = "interactive") {
  const token = await getLarkAccessToken();
  const res = await fetch(
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }),
    }
  );
  return res.json();
}

async function fetchISAPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ISABot/1.0)", "Accept-Language": "ja" },
    });
    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 8000);
  } catch (e) {
    return `ページ取得エラー: ${e.message}`;
  }
}

async function gatherISAContext() {
  const pages = [
    { url: "https://www.moj.go.jp/isa/index.html", label: "トップページ" },
    { url: "https://www.moj.go.jp/isa/applications/ssw/index.html", label: "特定技能制度" },
    { url: "https://www.moj.go.jp/isa/01_00461.html", label: "令和6年入管法改正" },
    { url: "https://www.moj.go.jp/isa/10_00222.html", label: "令和7年4月施行の省令改正" },
  ];
  const results = await Promise.all(
    pages.map(async (p) => {
      const text = await fetchISAPage(p.url);
      return `\n--- ${p.label} (${p.url}) ---\n${text}`;
    })
  );
  return results.join("\n");
}

async function generateAnswer(question, isaContext) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const systemPrompt = `あなたは登録支援機関の実務担当者をサポートする、入管庁（出入国在留管理庁）の制度に詳しいアシスタントです。

以下のルールに従ってください：
1. 入管庁の公式サイトから取得した情報をもとに回答する
2. 入管の堅い文言をそのまま使わず、登録支援機関の経営者・実務担当者がパッと理解できる平易な日本語で説明する
3. 回答は以下の構造で整理する：
   - まず質問に対する端的な回答（1〜2文）
   - 必要に応じて「やるべきこと」「気をつけること」を整理
   - 該当する公式ページのURLを末尾に添える
4. 情報が見つからない場合は正直に「現時点の公式サイトには該当情報が見つかりませんでした」と回答する
5. 回答は簡潔に（Larkで読みやすい分量で）

## 既知の重要な法改正情報

【2027年施行予定: 登録支援機関の要件厳格化】
- 支援担当者1名あたりの上限: 特定技能外国人50名まで、所属機関（受入企業）10社まで
- 支援責任者: 事務所ごとに常勤の役職員から1名以上選任（過去3年以内に法務大臣指定の講習修了者）
- 支援担当者: 常勤であることが必須に

【2025年4月1日施行済: 省令改正】
- 地域共生施策との連携（協力確認書の提出義務）
- 定期届出の頻度変更（四半期ごと→年1回）`;

  const userMessage = `## 入管庁公式サイトの最新情報\n${isaContext}\n\n## 質問\n${question}\n\n上記の公式情報をもとに、登録支援機関の実務に役立つ形で回答してください。`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].text;
}

function buildCardMessage(question, answer) {
  return {
    header: { title: { tag: "plain_text", content: "📋 入管庁情報 Q&A" }, template: "blue" },
    elements: [
      { tag: "markdown", content: `**質問:** ${question}` },
      { tag: "hr" },
      { tag: "markdown", content: answer },
      { tag: "hr" },
      { tag: "markdown", content: "📎 [入管庁公式サイト](https://www.moj.go.jp/isa/index.html) | ※AI回答のため、重要な判断は必ず原文をご確認ください" },
    ],
  };
}

const processedEvents = new Set();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = req.body;
  if (body.type === "url_verification") return res.status(200).json({ challenge: body.challenge });
  if (body.header && body.header.event_type === "im.message.receive_v1") {
    const eventId = body.header.event_id;
    if (processedEvents.has(eventId)) return res.status(200).json({ ok: true });
    processedEvents.add(eventId);
    if (processedEvents.size > 1000) { processedEvents.delete(processedEvents.values().next().value); }
    const event = body.event;
    const message = event.message;
    const chatId = message.chat_id;
    if (message.message_type !== "text") return res.status(200).json({ ok: true });
    let msgContent;
    try { msgContent = JSON.parse(message.content); } catch { return res.status(200).json({ ok: true }); }
    const text = msgContent.text || "";
    const mentions = event.message.mentions || [];
    const isBotMentioned = mentions.some((m) => m.name === LARK_BOT_NAME);
    const isChatP2p = message.chat_type === "p2p";
    if (!isBotMentioned && !isChatP2p) return res.status(200).json({ ok: true });
    let question = text;
    for (const m of mentions) { question = question.replace(m.key, "").trim(); }
    if (!question) return res.status(200).json({ ok: true });
    res.status(200).json({ ok: true });
    try {
      const isaContext = await gatherISAContext();
      const answer = await generateAnswer(question, isaContext);
      const card = buildCardMessage(question, answer);
      await sendLarkReply(chatId, card);
    } catch (err) {
      console.error("Error:", err);
      try {
        await sendLarkReply(chatId, {
          header: { title: { tag: "plain_text", content: "⚠️ エラー" }, template: "red" },
          elements: [{ tag: "markdown", content: `回答の生成中にエラーが発生しました。\nエラー: ${err.message}` }],
        });
      } catch {}
    }
    return;
  }
  return res.status(200).json({ ok: true });
}
