import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";

const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL || "https://open.larksuite.com/open-apis/bot/v2/hook/9e9906a0-bd84-4d6f-93a2-c29ae4f503fc";
const ISA_BASE = "https://www.moj.go.jp/isa/";
const ISA_NEWS = "https://www.moj.go.jp/isa/publications/newslist/index.html";
const anthropic = new Anthropic();

function stripWelTags(html) {
  return html.replace(/<wel[^>]*>/gi, "").replace(/<\/wel>/gi, "");
}

function parseImportantNotices(rawHtml) {
  const html = stripWelTags(rawHtml);
  const ulMatch = html.match(/<ul class="dateList02">[\s\S]*?<\/ul>/);
  if (!ulMatch) return [];
  const items = [];
  const liRe = /<li>[\s\S]*?<\/li>/g;
  let m;
  while ((m = liRe.exec(ulMatch[0])) !== null) {
    const aMatch = m[0].match(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (aMatch) {
      items.push({ title: aMatch[2].replace(/<[^>]+>/g, "").trim(), url: new URL(aMatch[1], ISA_BASE).href });
    }
  }
  return items;
}

function parseNewsItems(rawHtml) {
  const html = stripWelTags(rawHtml);
  const items = [];
  const liRe = /<li>\s*<div class="date">([\s\S]*?)<\/div>\s*<div class="cat"><span class="(cat\d+)">([\s\S]*?)<\/span><\/div>\s*<div class="txt"><a href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/div>\s*<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    items.push({
      date: m[1].replace(/<[^>]+>/g, "").trim(),
      category: m[3].replace(/<[^>]+>/g, "").trim(),
      title: m[5].replace(/<[^>]+>/g, "").trim(),
      url: new URL(m[4], ISA_BASE).href
    });
  }
  return items;
}

function filterRecentNews(items, daysBack = 2) {
  const now = new Date();
  return items.filter(item => {
    const match = item.date.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!match) return false;
    const itemDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const diff = (now - itemDate) / (1000 * 60 * 60 * 24);
    return diff <= daysBack;
  });
}

function analyzeImpact(item) {
  const t = item.title + " " + (item.category || "");
  if (/特定技能|登録支援|受入れ機関|届出|基準|改正|省令|告示/.test(t))
    return { level: "high", icon: "🔴", action: "やるべきこと（法的義務）" };
  if (/技能実習|育成就労|監理団体|在留資格|許可|審査/.test(t))
    return { level: "medium", icon: "🟡", action: "やらないといけないこと（確認必須）" };
  return { level: "info", icon: "🟢", action: "気をつけること（参考情報）" };
}

async function fetchDetailPage(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    return stripWelTags(await res.text());
  } catch { return null; }
}

function extractPdfLinks(html, baseUrl) {
  const links = [];
  const re = /<a[^>]+href="([^"]*\.pdf)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push(new URL(m[1], baseUrl).href);
  }
  return [...new Set(links)];
}

async function fetchPdfText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const data = await pdfParse(buffer);
    return data.text ? data.text.substring(0, 8000) : null;
  } catch (e) {
    return null;
  }
}

function extractPageMainText(html) {
  const mainMatch = html.match(/<div[^>]*class="[^"]*contents[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<!--/);
  const target = mainMatch ? mainMatch[1] : html;
  return target.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 6000);
}

async function summarizeWithClaude(title, pageText, pdfText) {
  const content = pdfText
    ? `【ページ本文】\n${pageText}\n\n【PDF内容】\n${pdfText}`
    : `【ページ本文】\n${pageText}`;
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `あなたは「登録支援機関」の実務担当者向けに、入管庁の更新情報を要約します。

タイトル: ${title}

${content}

以下の形式で簡潔に要約してください。各項目1-2文で。
■ 何が変わったか:
■ 登録支援機関への影響:
■ やるべきこと: `
      }]
    });
    return resp.content[0].text;
  } catch (e) {
    return null;
  }
}

async function enrichNewsWithSummary(items, maxItems = 3) {
  const highItems = items.filter(i => analyzeImpact(i).level === "high").slice(0, maxItems);
  for (const item of highItems) {
    try {
      const pageHtml = await fetchDetailPage(item.url);
      if (!pageHtml) continue;
      const pageText = extractPageMainText(pageHtml);
      const pdfLinks = extractPdfLinks(pageHtml, item.url);
      let pdfText = null;
      if (pdfLinks.length > 0) pdfText = await fetchPdfText(pdfLinks[0]);
      const summary = await summarizeWithClaude(item.title, pageText, pdfText);
      if (summary) { item.summary = summary; item.hasPdf = pdfLinks.length > 0; }
    } catch { /* skip */ }
  }
  return items;
}

function buildLarkCard(notices, news, date) {
  const elements = [];
  elements.push({ tag: "markdown", content: `📌 **入管庁 デイリーレポート** ｜ ${date}` });
  elements.push({ tag: "hr" });
  if (news.length > 0) {
    elements.push({ tag: "markdown", content: "**📰 新着情報**" });
    for (const item of news) {
      const impact = analyzeImpact(item);
      let line = `${impact.icon} 【${item.date}】[${item.title}](${item.url})`;
      line += `\n└ ${impact.action}`;
      if (item.summary) { line += `\n\n${item.summary}`; }
      elements.push({ tag: "markdown", content: line });
    }
    elements.push({ tag: "hr" });
  }
  const highItems = news.filter(i => analyzeImpact(i).level === "high");
  const medItems = news.filter(i => analyzeImpact(i).level === "medium");
  if (highItems.length > 0 || medItems.length > 0) {
    elements.push({ tag: "markdown", content: "**🎯 登録支援機関への影響**" });
    if (highItems.length > 0) elements.push({ tag: "markdown", content: "🔴 **重要度：高**\n" + highItems.map(i => `・${i.title}`).join("\n") });
    if (medItems.length > 0) elements.push({ tag: "markdown", content: "🟡 **重要度：中**\n" + medItems.map(i => `・${i.title}`).join("\n") });
    elements.push({ tag: "hr" });
  }
  if (notices.length > 0) {
    elements.push({ tag: "markdown", content: "**❗ 大事なお知らせ**" });
    elements.push({ tag: "markdown", content: notices.map(n => `・[${n.title}](${n.url})`).join("\n") });
    elements.push({ tag: "hr" });
  }
  if (new Date().getDay() === 1) {
    elements.push({ tag: "markdown", content: `**🔁 週次リマインド**\n🔴 定期届出：次回提出期限を確認\n🟡 要件厳格化：登録支援機関の要件確認を定期的に\n🟢 育成就労制度：最新の制度設計情報をウォッチ` });
    elements.push({ tag: "hr" });
  }
  elements.push({ tag: "markdown", content: `**🔗 クイックリンク**\n[入管庁トップ](${ISA_BASE}) | [更新情報一覧](${ISA_NEWS}) | [特定技能関連](https://www.moj.go.jp/isa/policies/ssw/index.html)` });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: "自動取得 by ISA News Monitor｜v5 AI要約付き" }] });
  return { msg_type: "interactive", card: { header: { title: { tag: "plain_text", content: `🇯🇵 入管庁ニュース ${date}` }, template: "blue" }, elements } };
}

export default async function handler(req, res) {
  try {
    const [isaRes, newsRes] = await Promise.all([
      fetch(ISA_BASE, { headers: { "User-Agent": "Mozilla/5.0" } }),
      fetch(ISA_NEWS, { headers: { "User-Agent": "Mozilla/5.0" } })
    ]);
    const isaHtml = await isaRes.text();
    const newsHtml = await newsRes.text();
    const notices = parseImportantNotices(isaHtml);
    const allNews = parseNewsItems(newsHtml);
    let recentNews = filterRecentNews(allNews, 2);
    if (recentNews.length === 0) recentNews = allNews.slice(0, 5);
    await enrichNewsWithSummary(recentNews, 3);
    const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Tokyo" });
    const card = buildLarkCard(notices, recentNews, today);
    const larkRes = await fetch(LARK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card)
    });
    const larkData = await larkRes.json();
    res.status(200).json({
      ok: true, lark: larkData,
      stats: { importantNotices: notices.length, allNews: allNews.length, recentNews: recentNews.length, summarized: recentNews.filter(i => i.summary).length }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
