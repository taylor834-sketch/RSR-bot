const express = require('express');
const { WebClient } = require('@slack/web-api');
const { createHmac } = require('crypto');

const app = express();

// ─── Config (set these as Railway environment variables) ───────────────────
const SLACK_BOT_TOKEN        = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET   = process.env.SLACK_SIGNING_SECRET;
const ANTHROPIC_API_KEY      = process.env.ANTHROPIC_API_KEY;
const ZAPIER_CREATE_WEBHOOK  = process.env.ZAPIER_CREATE_WEBHOOK;

// Notion client page IDs — add more as you onboard clients
const CLIENT_MAP = {
  'rsr-fexa': '8e2c66cc-e4ed-49d9-a1ee-f78c256707e4',
};

const slack = new WebClient(SLACK_BOT_TOKEN);

// ─── Slack request verification ────────────────────────────────────────────
function verifySlackSignature(req) {
  const timestamp  = req.headers['x-slack-request-timestamp'];
  const signature  = req.headers['x-slack-signature'];
  const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp) < fiveMinAgo) return false;
  const base = `v0:${timestamp}:${req.rawBody}`;
  const hash = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  return hash === signature;
}

// Raw body needed for signature verification
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => data += chunk);
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = Object.fromEntries(new URLSearchParams(data)); }
    next();
  });
});

// ─── Slack URL verification challenge ──────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  const body = req.body;

  // One-time URL verification — must respond before signature check
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  if (!verifySlackSignature(req)) return res.status(401).send('Unauthorized');

  // Acknowledge immediately — Slack requires response within 3s
  res.sendStatus(200);

  const event = body.event;
  if (!event) return;

  // Only handle app_mention events
  if (event.type !== 'app_mention') return;

  // Ignore bot's own messages
  if (event.bot_id) return;

  const channelName = await getChannelName(event.channel);
  const clientId    = CLIENT_MAP[channelName];

  if (!clientId) {
    // Channel not in the client map — silently ignore
    return;
  }

  // Get the message being replied to (parent message in thread)
  // If this is a thread reply, use thread_ts to fetch parent; otherwise use the mention text itself
  let sourceText = '';

  if (event.thread_ts && event.thread_ts !== event.ts) {
    // It's a thread reply — fetch the parent message
    const parent = await getThreadParent(event.channel, event.thread_ts);
    sourceText = parent || stripMention(event.text);
  } else {
    // Top-level mention — use any text after the @RSRBot mention
    sourceText = stripMention(event.text);
  }

  if (!sourceText.trim()) {
    await slack.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts || event.ts,
      text: "👋 I couldn't find a message to parse. Reply to a message with @RSRBot to create a ticket from it.",
    });
    return;
  }

  // Parse with Claude
  let ticket;
  try {
    ticket = await parseWithClaude(sourceText);
  } catch (err) {
    console.error('Claude parse error:', err);
    await slack.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts || event.ts,
      text: '⚠️ Something went wrong parsing that message. Try again.',
    });
    return;
  }

  // Post ephemeral preview with Edit / Create buttons
  await slack.chat.postEphemeral({
    channel: event.channel,
    user: event.user,
    thread_ts: event.thread_ts || event.ts,
    text: 'Ticket preview',
    blocks: buildPreviewBlocks(ticket, event.channel, event.thread_ts || event.ts, clientId, channelName),
  });
});

// ─── Interactive component handler (button clicks) ─────────────────────────
app.post('/slack/interactions', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('Unauthorized');

  res.sendStatus(200); // Acknowledge fast

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return;
  }

  if (payload.type !== 'block_actions') return;

  const action     = payload.actions[0];
  const actionId   = action.action_id;
  const value      = JSON.parse(action.value);
  const { ticket, channel, thread_ts, client_id, channel_name } = value;

  if (actionId === 'create_ticket') {
    // Send to Zapier webhook → Notion
    try {
      await fetch(ZAPIER_CREATE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, channel, thread_ts, client_id }),
      });

      // Post public confirmation in thread
      await slack.chat.postMessage({
        channel,
        thread_ts,
        username: 'RSR Bot',
        icon_emoji: ':white_check_mark:',
        text: 'Ticket created',
        blocks: buildConfirmationBlocks(ticket),
      });

    } catch (err) {
      console.error('Create ticket error:', err);
      await slack.chat.postEphemeral({
        channel,
        user: payload.user.id,
        thread_ts,
        text: '⚠️ Failed to create the ticket. Try again.',
      });
    }
  }

  if (actionId === 'edit_ticket') {
    // Open a modal for editing
    await slack.views.open({
      trigger_id: payload.trigger_id,
      view: buildEditModal(ticket, channel, thread_ts, client_id, channel_name),
    });
  }
});

// ─── Modal submission handler ──────────────────────────────────────────────
app.post('/slack/modals', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('Unauthorized');

  res.sendStatus(200);

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch { return; }

  if (payload.type !== 'view_submission') return;

  const meta    = JSON.parse(payload.view.private_metadata);
  const vals    = payload.view.state.values;

  const ticket = {
    title:    vals.title_block.title_input.value,
    priority: vals.priority_block.priority_select.selected_option.value,
    effort:   vals.effort_block.effort_select.selected_option.value,
    due_date: vals.due_block.due_input.value || null,
    notes:    vals.notes_block.notes_input.value,
  };

  try {
    await fetch(ZAPIER_CREATE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, channel: meta.channel, thread_ts: meta.thread_ts, client_id: meta.client_id }),
    });

    await slack.chat.postMessage({
      channel: meta.channel,
      thread_ts: meta.thread_ts,
      username: 'RSR Bot',
      icon_emoji: ':white_check_mark:',
      text: 'Ticket created',
      blocks: buildConfirmationBlocks(ticket),
    });
  } catch (err) {
    console.error('Modal submit error:', err);
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function getChannelName(channelId) {
  try {
    const info = await slack.conversations.info({ channel: channelId });
    return info.channel.name;
  } catch { return ''; }
}

async function getThreadParent(channel, thread_ts) {
  try {
    const result = await slack.conversations.replies({ channel, ts: thread_ts, limit: 1 });
    const parent = result.messages?.[0];
    return parent?.text || '';
  } catch { return ''; }
}

function stripMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

async function parseWithClaude(text) {
  const today = new Date().toISOString().split('T')[0];
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You are a ticket parser for a RevOps consulting business. Read the message and extract structured ticket data.

Return ONLY a valid JSON object with exactly these fields:
{
  "title": "concise 5-10 word task summary",
  "priority": "High" | "Medium" | "Low",
  "effort": "XS" | "S" | "M" | "L" | "XL",
  "due_date": "YYYY-MM-DD or null",
  "notes": "clean rewrite of the full request as a task description"
}

Priority: infer from urgency, impact, or blocking language. Default Medium.
Effort: XS = <30min, S = ~1hr, M = half day, L = full day, XL = multi-day. Default M.
Due date: resolve relative dates to absolute. Today is ${today}. Return null if no date mentioned.
Notes: preserve all context, written as a clear task description.
No preamble, no markdown fences. JSON only.`,
      messages: [{ role: 'user', content: text }],
    }),
  });

  const data = await response.json();
  const raw  = data.content?.[0]?.text || '{}';
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

const PRIORITY_EMOJI = { High: '🔴', Medium: '🟡', Low: '🟢' };
const EFFORT_LABEL   = { XS: 'XS (<30m)', S: 'S (~1hr)', M: 'M (half day)', L: 'L (full day)', XL: 'XL (multi-day)' };

function buildPreviewBlocks(ticket, channel, thread_ts, client_id, channel_name) {
  const buttonValue = JSON.stringify({ ticket, channel, thread_ts, client_id, channel_name });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*🎫 Ticket Preview*\nReview before creating:' } },
    { type: 'divider' },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*📋 Title*\n${ticket.title}` },
      { type: 'mrkdwn', text: `*${PRIORITY_EMOJI[ticket.priority] || '🟡'} Priority*\n${ticket.priority}` },
      { type: 'mrkdwn', text: `*📏 Effort*\n${EFFORT_LABEL[ticket.effort] || ticket.effort}` },
      { type: 'mrkdwn', text: `*📅 Due*\n${ticket.due_date || 'Not set'}` },
    ]},
    { type: 'section', text: { type: 'mrkdwn', text: `*📝 Notes*\n${ticket.notes}` } },
    { type: 'divider' },
    { type: 'actions', elements: [
      { type: 'button', action_id: 'create_ticket', style: 'primary', text: { type: 'plain_text', text: '✅ Create Ticket' }, value: buttonValue },
      { type: 'button', action_id: 'edit_ticket',   text: { type: 'plain_text', text: '✏️ Edit' },                           value: buttonValue },
    ]},
  ];
}

function buildConfirmationBlocks(ticket) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `✅ *Ticket Created*` } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*📋 Title*\n${ticket.title}` },
      { type: 'mrkdwn', text: `*${PRIORITY_EMOJI[ticket.priority] || '🟡'} Priority*\n${ticket.priority}` },
      { type: 'mrkdwn', text: `*📏 Effort*\n${EFFORT_LABEL[ticket.effort] || ticket.effort}` },
      { type: 'mrkdwn', text: `*📅 Due*\n${ticket.due_date || 'Not set'}` },
    ]},
    { type: 'section', text: { type: 'mrkdwn', text: `*📝 Notes*\n${ticket.notes}` } },
  ];
}

function buildEditModal(ticket, channel, thread_ts, client_id, channel_name) {
  return {
    type: 'modal',
    callback_id: 'edit_ticket_modal',
    private_metadata: JSON.stringify({ channel, thread_ts, client_id, channel_name }),
    title: { type: 'plain_text', text: '✏️ Edit Ticket' },
    submit: { type: 'plain_text', text: 'Create Ticket' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'input', block_id: 'title_block', label: { type: 'plain_text', text: 'Title' },
        element: { type: 'plain_text_input', action_id: 'title_input', initial_value: ticket.title } },
      { type: 'input', block_id: 'priority_block', label: { type: 'plain_text', text: 'Priority' },
        element: { type: 'static_select', action_id: 'priority_select',
          initial_option: { text: { type: 'plain_text', text: ticket.priority }, value: ticket.priority },
          options: ['High','Medium','Low'].map(p => ({ text: { type: 'plain_text', text: p }, value: p })) } },
      { type: 'input', block_id: 'effort_block', label: { type: 'plain_text', text: 'Effort' },
        element: { type: 'static_select', action_id: 'effort_select',
          initial_option: { text: { type: 'plain_text', text: ticket.effort }, value: ticket.effort },
          options: ['XS','S','M','L','XL'].map(e => ({ text: { type: 'plain_text', text: e }, value: e })) } },
      { type: 'input', block_id: 'due_block', optional: true, label: { type: 'plain_text', text: 'Due Date (YYYY-MM-DD)' },
        element: { type: 'plain_text_input', action_id: 'due_input', initial_value: ticket.due_date || '' } },
      { type: 'input', block_id: 'notes_block', label: { type: 'plain_text', text: 'Notes' },
        element: { type: 'plain_text_input', action_id: 'notes_input', multiline: true, initial_value: ticket.notes } },
    ],
  };
}

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RSR Bot running on port ${PORT}`));
