// =============================================================================
// Telegram — the Elpa demo app
// -----------------------------------------------------------------------------
// A realistic, Telegram-style messenger built entirely on the Elpa SDK (see
// `assets/app/sdk/`). It runs on the Elpian VM and drives the Flutter UI through
// the message pipe. It exercises every part of the SDK:
//
//   * Navigation  — a stack router: chat list -> chat -> back, list -> settings,
//                   list -> contacts -> new chat.
//   * Components  — isolated, repaint-scoped pieces (chat list, message list,
//                   chat header status, composer) that patch only themselves.
//   * Timing      — host-backed timers/animations: a "typing…" indicator that
//                   animates, simulated peer replies after a delay, and ambient
//                   background messages arriving into the chat list.
//   * Widgets     — avatars, bubbles with read receipts, unread badges, a real
//                   text composer, switches, dividers, scrolling lists.
//   * Theme       — Telegram dark/light palettes, switchable live from Settings.
//
// The whole UI is authored as objects (`new Column([...])`), never hand-written
// JSON — that is the point of the SDK.
// =============================================================================

var app = new App();

// ---- Small utilities --------------------------------------------------------

var ID_SEQ = 1000;
function nextId() { ID_SEQ = ID_SEQ + 1; return ID_SEQ; }

// A faux wall clock so messages get plausible, advancing timestamps.
var CLOCK_MIN = 9 * 60 + 41; // 09:41
function pad2(n) { let s = str(n); if (len(s) < 2) return "0" + s; return s; }
function clockLabel() {
  let hh = int(CLOCK_MIN / 60) % 24;
  let mm = CLOCK_MIN % 60;
  CLOCK_MIN = CLOCK_MIN + 2;
  return pad2(hh) + ":" + pad2(mm);
}
function noop() {}

function theme() { return app.theme; }
function colors() { return app.theme.colors; }

// ---- Data model -------------------------------------------------------------

function makeMessage(text, mine, status) {
  return { id: nextId(), text: text, mine: mine, timeLabel: clockLabel(), status: status };
}

function makeChat(name, online, verified, muted, pinned, seed) {
  return {
    id: nextId(),
    name: name,
    online: online,
    verified: verified,
    muted: muted,
    pinned: pinned,
    typing: false,
    unread: 0,
    timeLabel: clockLabel(),
    messages: [],
    replyIndex: 0,
    replies: seed,
  };
}

// Canned replies each chat cycles through, so the "peer" answers sensibly.
var GENERIC_REPLIES = [
  "Sounds good 👍", "Haha for sure", "Let me check and get back to you",
  "On my way!", "That works for me", "Nice, thanks!", "👍", "See you then",
];

function buildData() {
  let saved = makeChat("Saved Messages", false, false, false, true, ["Noted ✓"]);
  push(saved.messages, makeMessage("Project plan v3 — final.pdf", true, "read"));
  push(saved.messages, makeMessage("Don't forget the demo on Friday", true, "read"));

  let alice = makeChat("Alice Johnson", true, false, false, false,
    ["I'm finishing the slides now", "Give me 10 minutes", "Done — sending over"]);
  push(alice.messages, makeMessage("Hey! Are we still on for the review?", false, "in"));
  push(alice.messages, makeMessage("Yes, 3pm works great", true, "read"));
  push(alice.messages, makeMessage("Perfect, I'll prepare the deck", false, "in"));

  let team = makeChat("Design Team", false, true, false, false,
    ["Pushed the new icons", "Check Figma", "LGTM 🚀"]);
  push(team.messages, makeMessage("New mockups are up for the chat screen", false, "in"));
  push(team.messages, makeMessage("Love the bubble radii", true, "read"));

  let bob = makeChat("Bob Martinez", false, false, true, false,
    ["Cool", "Yeah", "Talk later"]);
  push(bob.messages, makeMessage("Did you see the game last night?", false, "in"));
  bob.unread = 2;

  let mom = makeChat("Mom", true, false, false, false,
    ["Call me when you can ❤️", "Ok dear", "Love you"]);
  push(mom.messages, makeMessage("Are you eating well?", false, "in"));
  mom.unread = 1;

  let notifications = makeChat("Telegram", false, true, false, false,
    ["Your login code is 24816"]);
  push(notifications.messages, makeMessage("Welcome to Telegram on Elpa!", false, "in"));

  return {
    me: { name: "You", phone: "+1 415 555 0142", username: "@you" },
    notificationsOn: true,
    chats: [saved, alice, team, bob, mom, notifications],
  };
}

var DATA = buildData();

function lastMessage(chat) {
  if (len(chat.messages) === 0) return NIL;
  return chat.messages[len(chat.messages) - 1];
}

function markChatRead(chat) {
  chat.unread = 0;
  for (let i = 0; i < len(chat.messages); i++) {
    if (chat.messages[i].mine) chat.messages[i].status = "read";
  }
}

function nextReply(chat) {
  let pool = (isNull(chat.replies) || len(chat.replies) === 0) ? GENERIC_REPLIES : chat.replies;
  let idx = chat.replyIndex % len(pool);
  chat.replyIndex = chat.replyIndex + 1;
  return pool[idx];
}

// =============================================================================
// Reusable UI pieces
// =============================================================================

function unreadBadge(chat) {
  let c = colors();
  if (chat.unread <= 0) {
    if (chat.pinned) return new Icon("pin").size(16).color(c.textMuted);
    return new SizedBox(0, 0);
  }
  let bg = chat.muted ? c.textMuted : c.unreadBadge;
  return new Container(
    new Center(new Text(str(chat.unread)).size(12).bold().color("#FFFFFF"))
  ).height(20).pad({ left: 7, top: 0, right: 7, bottom: 0 }).color(bg).radius(10);
}

// One row in the chat list: avatar, name (+ badges), preview, time, unread.
function chatRow(chat) {
  let c = colors();
  let preview = lastMessage(chat);
  let previewText = "";
  if (!isNull(preview)) {
    previewText = preview.mine ? ("You: " + preview.text) : preview.text;
  }
  if (chat.typing) previewText = "typing…";

  let avatar = new Avatar(chat.name, 54);
  if (chat.online) avatar.online(c.online);

  let titleChildren = [
    new Flexible(new Text(chat.name).size(16).bold().color(c.textPrimary).oneLine()).flex(1),
  ];
  if (chat.verified) push(titleChildren, new Padding({ left: 4, top: 0, right: 0, bottom: 0 }, new Icon("verified").size(16).color(c.primary)));
  if (chat.muted) push(titleChildren, new Padding({ left: 4, top: 0, right: 0, bottom: 0 }, new Icon("mute").size(15).color(c.textMuted)));
  push(titleChildren, new SizedBox(8, 0));
  push(titleChildren, new Text(chat.timeLabel).size(12).color(c.textSecondary));
  let titleRow = new Row(titleChildren).crossAxis("center");

  let previewColor = chat.typing ? c.primary : c.textSecondary;
  let subtitleRow = new Row([
    new Flexible(new Text(previewText).size(14).color(previewColor).oneLine()).flex(1),
    new SizedBox(8, 0),
    unreadBadge(chat),
  ]).crossAxis("center");

  let textCol = new Column([titleRow, new SizedBox(0, 4), subtitleRow]).crossAxis("start").shrink();

  let row = new Row([
    avatar,
    new SizedBox(12, 0),
    new Expanded(textCol),
  ]).crossAxis("center");

  return new Tappable(
    new Container(new Padding({ left: 14, top: 8, right: 12, bottom: 8 }, row))
  ).onTap(() => openChat(chat)).withKey("chatrow." + str(chat.id));
}

// A single chat bubble with timestamp and (for outgoing) read receipts.
function bubble(msg) {
  let c = colors();
  let isMine = msg.mine;
  let bg = isMine ? c.bubbleOut : c.bubbleIn;
  let fg = isMine ? c.bubbleOutText : c.bubbleInText;

  let metaChildren = [new Text(msg.timeLabel).size(11).color(isMine ? "#A8C7E8" : c.textSecondary)];
  if (isMine) {
    let isRead = msg.status === "read";
    push(metaChildren, new SizedBox(4, 0));
    push(metaChildren, new Icon(isRead ? "done_all" : "check").size(14).color(isRead ? "#5FD0F3" : "#A8C7E8"));
  }
  let meta = new Row(metaChildren).shrink().crossAxis("center");

  let body = new Column([
    new Text(msg.text).size(15.5).color(fg),
    new SizedBox(0, 3),
    new Align("centerEnd", meta),
  ]).crossAxis("start").shrink();

  let box = new Container(new Padding({ left: 11, top: 7, right: 11, bottom: 6 }, body)).color(bg).radius(15);

  // Cap the bubble width with a flex pair so long text wraps instead of spanning
  // the whole row; short bubbles shrink to fit.
  let line;
  if (isMine) {
    line = new Row([new Spacer().flex(1), new Flexible(box).flex(5)]);
  } else {
    line = new Row([new Flexible(box).flex(5), new Spacer().flex(1)]);
  }
  return new Padding({ left: 8, top: 2, right: 8, bottom: 2 }, line);
}

function dateChip(label) {
  let c = colors();
  return new Center(
    new Padding({ left: 0, top: 8, right: 0, bottom: 8 },
      new Container(new Padding({ left: 12, top: 4, right: 12, bottom: 4 },
        new Text(label).size(12).color("#FFFFFF"))
      ).color("#22000000").radius(12))
  );
}

// A top app bar styled like Telegram's: a coloured bar that pads under the status
// bar (SafeArea top) and lays its leading/title/actions out in a row.
function appBar(children) {
  let c = colors();
  return new Container(
    new SafeArea(
      new Padding({ left: 4, top: 4, right: 6, bottom: 6 },
        new Row(children).crossAxis("center"))
    ).edges(true, false, true, true)
  ).color(c.appBar);
}

function settingsRow(iconName, label, trailing, onTap) {
  let c = colors();
  let row = new Row([
    new Icon(iconName).size(24).color(c.primary),
    new SizedBox(18, 0),
    new Expanded(new Text(label).size(16).color(c.textPrimary)),
    isNull(trailing) ? new SizedBox(0, 0) : trailing,
  ]).crossAxis("center");
  let content = new Container(new Padding({ left: 16, top: 14, right: 16, bottom: 14 }, row));
  if (isNull(onTap)) return content;
  return new Tappable(content).onTap(onTap).withKey("set." + label);
}

function sectionLabel(text) {
  let c = colors();
  return new Container(new Padding({ left: 16, top: 14, right: 16, bottom: 6 },
    new Text(upper(text)).size(13).bold().color(c.primary))).color(c.surface);
}

// =============================================================================
// Components (isolated render scopes)
// =============================================================================

/// The chat list — re-renders itself when ambient messages arrive.
class ChatListBody extends Component {
  constructor() { super("scope.chatlist"); }
  build() {
    let rows = [];
    for (let i = 0; i < len(DATA.chats); i++) {
      push(rows, chatRow(DATA.chats[i]));
      push(rows, new Divider().height(0.5).color(colors().divider).indent(80));
    }
    return new Container(new ListView(rows)).color(colors().surface);
  }
}

/// The scrolling message history for one chat.
class MessageList extends Component {
  constructor(chat) {
    super("scope.messages");
    this.chat = chat;
  }
  build() {
    let items = [dateChip("Today")];
    for (let i = 0; i < len(this.chat.messages); i++) {
      push(items, bubble(this.chat.messages[i]));
    }
    push(items, new SizedBox(0, 8));
    return new ListView(items).pad({ left: 0, top: 6, right: 0, bottom: 6 });
  }
}

/// The chat header's status line ("online" / "last seen" / animated "typing…").
class ChatStatus extends Component {
  constructor(chat) {
    super("scope.chatstatus");
    this.chat = chat;
    this.state = { dots: 1 };
  }
  statusText() {
    if (this.chat.typing) {
      let s = "typing";
      for (let i = 0; i < this.state.dots; i++) s = s + ".";
      return s;
    }
    if (this.chat.online) return "online";
    return "last seen recently";
  }
  build() {
    let c = colors();
    let isActive = this.chat.typing || this.chat.online;
    return new Column([
      new Text(this.chat.name).size(16).bold().color(c.textPrimary),
      new Text(this.statusText()).size(13).color(isActive ? c.primary : c.textSecondary),
    ]).crossAxis("start").shrink();
  }
}

/// The message composer: attach, text field, emoji, and a send/mic button.
class Composer extends Component {
  constructor(page) {
    super("scope.composer");
    this.page = page;
    this.state = { text: "", clearNonce: 0 };
  }
  doSend() {
    let t = trim(this.state.text);
    if (len(t) === 0) return;
    this.state.text = "";
    this.state.clearNonce = this.state.clearNonce + 1;
    this.page.sendMessage(t);
    this.setState(NIL); // re-render so the field clears via the new nonce
  }
  build() {
    let c = colors();
    let field = new Field()
      .hint("Message")
      .radius(22)
      .fill(c.inputBg)
      .textColor(c.textPrimary)
      .hintColor(c.textSecondary)
      .multiline(1, 5)
      .clearOnSubmit()
      .clearNonce(this.state.clearNonce)
      .onChanged((p) => { this.state.text = p.value; })
      .onSubmitted((p) => { this.page.sendMessage(p.value); })
      .withKey("composer.field");

    let sendButton = new Tappable(
      new Container(new Center(new Icon("send").size(20).color("#FFFFFF")))
        .size(46, 46).color(c.primary).radius(23)
    ).onTap(() => this.doSend()).withKey("composer.send");

    let bar = new Row([
      new IconButton("attach").color(c.textSecondary).size(24).onTap(noop).withKey("composer.attach"),
      new Expanded(field),
      new IconButton("emoji").color(c.textSecondary).size(24).onTap(noop).withKey("composer.emoji"),
      new SizedBox(4, 0),
      sendButton,
    ]).crossAxis("center");

    return new Container(
      new SafeArea(
        new Padding({ left: 6, top: 6, right: 8, bottom: 6 }, bar)
      ).edges(false, true, true, true)
    ).color(c.surface);
  }
}

// =============================================================================
// Pages
// =============================================================================

class ChatListPage extends Page {
  constructor() {
    super("Chats");
    this.body = new ChatListBody();
    this.ambientTimer = NIL;
  }
  onEnter() {
    // Ambient simulation: every few seconds an unread message lands in a random
    // background chat, and the list patches itself — a live, host-timer-driven
    // feed without us touching the rest of the UI.
    let self = this;
    this.ambientTimer = app.scheduler.setInterval(() => { self.injectAmbient(); }, 6000);
  }
  onLeave() {
    if (!isNull(this.ambientTimer)) { app.scheduler.cancel(this.ambientTimer); this.ambientTimer = NIL; }
  }
  injectAmbient() {
    // Pick a peer chat (skip Saved Messages at index 0).
    let idx = 1 + (app.host.randomInt(0, len(DATA.chats) - 2));
    if (idx >= len(DATA.chats)) idx = len(DATA.chats) - 1;
    let chat = DATA.chats[idx];
    push(chat.messages, makeMessage(nextReply(chat), false, "in"));
    chat.unread = chat.unread + 1;
    chat.timeLabel = clockLabel();
    this.body.setState(NIL);
  }
  build() {
    let c = colors();
    let bar = appBar([
      new IconButton("menu").color("#FFFFFF").size(24).onTap(() => openSettings()).withKey("ab.menu"),
      new SizedBox(8, 0),
      new Expanded(new Text("Telegram").size(20).bold().color("#FFFFFF")),
      new IconButton("search").color("#FFFFFF").size(24).onTap(noop).withKey("ab.search"),
      new IconButton("more").color("#FFFFFF").size(24).onTap(noop).withKey("ab.more"),
    ]);

    let fab = new Tappable(
      new Container(new Center(new Icon("new_chat").size(24).color("#FFFFFF")))
        .size(56, 56).color(c.primary).radius(28)
    ).onTap(() => openContacts()).withKey("fab.compose");

    return new Scaffold()
      .background(c.background)
      .body(new Column([bar, new Expanded(this.body)]).crossAxis("stretch"))
      .fab(fab);
  }
}

class ChatPage extends Page {
  constructor(chat) {
    super(chat.name);
    this.chat = chat;
    this.messages = new MessageList(chat);
    this.status = new ChatStatus(chat);
    this.composer = new Composer(this);
    this.replyTimer = NIL;
    this.typingAnim = NIL;
  }
  onEnter() {
    markChatRead(this.chat);
  }
  onLeave() {
    this.chat.typing = false;
    if (!isNull(this.replyTimer)) { app.scheduler.cancel(this.replyTimer); this.replyTimer = NIL; }
    if (!isNull(this.typingAnim)) { app.scheduler.cancel(this.typingAnim); this.typingAnim = NIL; }
  }
  sendMessage(text) {
    let t = trim(text);
    if (len(t) === 0) return;
    push(this.chat.messages, makeMessage(t, true, "sent"));
    this.messages.setState(NIL);
    this.scheduleReply();
  }
  scheduleReply() {
    let self = this;
    // Peer starts "typing…" with an animated indicator (host-timer driven).
    self.chat.typing = true;
    self.status.setState(NIL);
    self.typingAnim = app.scheduler.setInterval(() => {
      self.status.setState((s) => { s.dots = (s.dots % 3) + 1; });
    }, 400);

    self.replyTimer = app.scheduler.setTimeout(() => {
      if (!isNull(self.typingAnim)) { app.scheduler.cancel(self.typingAnim); self.typingAnim = NIL; }
      self.chat.typing = false;
      // Our delivered messages are now read.
      for (let i = 0; i < len(self.chat.messages); i++) {
        if (self.chat.messages[i].mine) self.chat.messages[i].status = "read";
      }
      push(self.chat.messages, makeMessage(nextReply(self.chat), false, "in"));
      self.messages.setState(NIL);
      self.status.setState(NIL);
    }, 1800);
  }
  build() {
    let c = colors();
    let avatar = new Avatar(this.chat.name, 38);
    if (this.chat.online) avatar.online(c.online);

    let bar = appBar([
      new IconButton("back").color("#FFFFFF").size(24).onTap(() => goBack()).withKey("chat.back"),
      new SizedBox(2, 0),
      avatar,
      new SizedBox(10, 0),
      new Expanded(this.status),
      new IconButton("call").color("#FFFFFF").size(22).onTap(noop).withKey("chat.call"),
      new IconButton("more").color("#FFFFFF").size(24).onTap(noop).withKey("chat.more"),
    ]);

    return new Scaffold()
      .background(c.background)
      .body(new Column([
        bar,
        new Expanded(new Container(this.messages).color(c.background)),
        this.composer,
      ]).crossAxis("stretch"));
  }
}

class SettingsPage extends Page {
  constructor() { super("Settings"); }
  build() {
    let c = colors();
    let header = new Container(
      new SafeArea(
        new Padding({ left: 16, top: 10, right: 16, bottom: 18 },
          new Column([
            new Row([
              new IconButton("back").color("#FFFFFF").size(24).onTap(() => goBack()).withKey("set.back"),
              new Expanded(new Text("Settings").size(20).bold().color("#FFFFFF")),
              new IconButton("edit").color("#FFFFFF").size(22).onTap(noop).withKey("set.edit"),
            ]).crossAxis("center"),
            new SizedBox(0, 16),
            new Row([
              new Avatar(DATA.me.name, 72),
              new SizedBox(16, 0),
              new Column([
                new Text(DATA.me.name).size(22).bold().color("#FFFFFF"),
                new SizedBox(0, 4),
                new Text(DATA.me.phone + "  ·  " + DATA.me.username).size(14).color("#CFE2F3"),
              ]).crossAxis("start").shrink(),
            ]).crossAxis("center"),
          ]).crossAxis("start").shrink())
      ).edges(true, false, true, true)
    ).color(c.appBar);

    let notifSwitch = new Switcher(DATA.notificationsOn)
      .onChanged((p) => { DATA.notificationsOn = p.value; app.render(); })
      .withKey("set.notifswitch");

    let themeSwitch = new Switcher(THEME_MODE === "dark")
      .onChanged((p) => { toggleTheme(p.value); })
      .withKey("set.themeswitch");

    let list = new Column([
      sectionLabel("Account"),
      settingsRow("key", "Privacy and Security", NIL, noop),
      new Divider().height(0.5).color(c.divider).indent(58),
      settingsRow("storage", "Data and Storage", NIL, noop),
      new Divider().height(0.5).color(c.divider).indent(58),
      sectionLabel("Preferences"),
      settingsRow("notifications", "Notifications", notifSwitch, NIL),
      new Divider().height(0.5).color(c.divider).indent(58),
      settingsRow("palette", "Dark theme", themeSwitch, NIL),
      new Divider().height(0.5).color(c.divider).indent(58),
      settingsRow("language", "Language", new Text("English").size(15).color(c.textSecondary), noop),
      new Divider().height(0.5).color(c.divider).indent(58),
      sectionLabel("More"),
      settingsRow("help", "Help", NIL, noop),
      settingsRow("logout", "Log Out", NIL, noop),
    ]).crossAxis("stretch").shrink();

    return new Scaffold()
      .background(c.surface)
      .body(new ScrollView(new Column([header, list]).crossAxis("stretch").shrink()));
  }
}

class ContactsPage extends Page {
  constructor() { super("Contacts"); }
  build() {
    let c = colors();
    let bar = appBar([
      new IconButton("back").color("#FFFFFF").size(24).onTap(() => goBack()).withKey("ct.back"),
      new SizedBox(8, 0),
      new Expanded(new Text("New Message").size(19).bold().color("#FFFFFF")),
      new IconButton("search").color("#FFFFFF").size(24).onTap(noop).withKey("ct.search"),
    ]);
    let rows = [];
    for (let i = 0; i < len(DATA.chats); i++) {
      let chat = DATA.chats[i];
      let presence = chat.online ? "online" : "last seen recently";
      let tile = new Tappable(
        new Container(new Padding({ left: 14, top: 8, right: 14, bottom: 8 },
          new Row([
            new Avatar(chat.name, 48),
            new SizedBox(14, 0),
            new Expanded(new Column([
              new Text(chat.name).size(16).color(c.textPrimary),
              new SizedBox(0, 2),
              new Text(presence).size(13).color(chat.online ? c.primary : c.textSecondary),
            ]).crossAxis("start").shrink()),
          ]).crossAxis("center")))
      ).onTap(() => { goBack(); openChat(chat); }).withKey("ct." + str(chat.id));
      push(rows, tile);
    }
    return new Scaffold()
      .background(c.surface)
      .body(new Column([bar, new Expanded(new Container(new ListView(rows)).color(c.surface))]).crossAxis("stretch"));
  }
}

// =============================================================================
// Navigation actions
// =============================================================================

function openChat(chat) { app.navigator.push(new ChatPage(chat)); }
function openSettings() { app.navigator.push(new SettingsPage()); }
function openContacts() { app.navigator.push(new ContactsPage()); }
function goBack() { app.navigator.pop(); }

// ---- Theme switching --------------------------------------------------------

var THEME_MODE = "dark";
function toggleTheme(wantDark) {
  THEME_MODE = wantDark ? "dark" : "light";
  app.theme = wantDark ? Theme.telegramDark() : Theme.telegramLight();
  app.render();
}

// =============================================================================
// Bootstrap + VM lifecycle
// =============================================================================

app.navigator.mount(new ChatListPage());
app.start(() => app.navigator.build());

// The Elpian VM calls these top-level lifecycle handlers; fan them into the App.
function onHostMessage(msg) { app.handleHostMessage(msg); }
function onFrame(dt) { app.handleFrame(dt); }
function onResize(info) { app.handleResize(info); }
