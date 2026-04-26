/* ============================================================
   COFE Properties — AI Chat Widget  (chat.js)
   Drop <script src="chat.js"></script> before </body> on any page.
   ============================================================ */

const ANTHROPIC_API_KEY = 'REPLACE_WITH_API_KEY';
const CHAT_MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are a CRE analyst for COFE Properties. You have access to the company's industrial comp database. Answer questions about nearby sales, rent comps, pricing trends, cap rates, and provide investment analysis. Be concise and specific, citing actual comp data.

When data is provided, reference specific properties by address, price, PSF, cap rate, date, etc. If the user asks about a market or area, summarize key metrics (avg PSF, cap rate range, recent activity). Format numbers with commas and dollar signs.`;

/* ---- layer-type labels ---- */
const LAYER_LABELS = {
  ind_sale: 'Industrial Sale', ind_lease: 'Industrial Lease',
  ios_sale: 'IOS Sale', ios_rent: 'IOS Rent',
  ios_pipeline: 'IOS Pipeline', cofe_owned: 'COFE Owned', cofe_sold: 'COFE Sold'
};

/* ---- market bounding boxes for smart filtering ---- */
const MARKET_KEYWORDS = {
  houston: ['houston','sugar land','katy','pasadena','baytown','spring','humble','cypress','tomball','pearland','league city','webster','friendswood','missouri city','stafford'],
  dfw: ['dallas','fort worth','dfw','arlington','irving','plano','frisco','mckinney','denton','carrollton','lewisville','garland','richardson','grand prairie','mesquite','haltom','richland hills'],
  miami: ['miami','doral','medley','hialeah','opa-locka','deerfield','pompano','fort lauderdale','oakland park','coral springs','dania','hollywood','pembroke','davie','sunrise','plantation','boca raton','boynton','delray','west palm'],
  'san antonio': ['san antonio','new braunfels','schertz','converse','live oak','selma'],
  austin: ['austin','round rock','pflugerville','cedar park','georgetown','san marcos','kyle','buda'],
  atlanta: ['atlanta','kennesaw','marietta','norcross','duluth','lawrenceville','mcdonough','lithia springs','college park','peachtree','alpharetta','roswell','smyrna','tucker'],
  orlando: ['orlando','kissimmee','sanford','apopka','ocoee','winter park','lake mary','altamonte'],
  tampa: ['tampa','st petersburg','clearwater','brandon','lakeland','plant city','riverview','wesley chapel'],
  charlotte: ['charlotte','concord','huntersville','mooresville','gastonia','rock hill','matthews','mint hill'],
  charleston: ['charleston','north charleston','mount pleasant','summerville','goose creek','hanahan'],
  jacksonville: ['jacksonville','orange park','st augustine','fernandina','ponte vedra']
};

(function() {
  /* ---- inject styles ---- */
  const style = document.createElement('style');
  style.textContent = `
    #cofe-chat-btn {
      position:fixed; bottom:24px; right:24px; z-index:9999;
      width:52px; height:52px; border-radius:50%; border:none;
      background:linear-gradient(135deg,#3b82f6,#a855f7); color:#fff;
      font-size:22px; cursor:pointer; box-shadow:0 4px 20px rgba(59,130,246,0.4);
      transition:all .2s; display:flex; align-items:center; justify-content:center;
    }
    #cofe-chat-btn:hover { transform:scale(1.08); box-shadow:0 6px 28px rgba(59,130,246,0.5); }
    #cofe-chat-btn.has-badge::after {
      content:''; position:absolute; top:2px; right:2px; width:12px; height:12px;
      border-radius:50%; background:#4ade80; border:2px solid #0b1220;
    }

    #cofe-chat-panel {
      position:fixed; bottom:86px; right:24px; z-index:9998;
      width:400px; height:500px; max-height:calc(100vh - 110px);
      background:#1e1e2e; border:1px solid #2a2a4a; border-radius:12px;
      display:none; flex-direction:column; overflow:hidden;
      box-shadow:0 8px 40px rgba(0,0,0,0.5);
    }
    #cofe-chat-panel.open { display:flex; }

    #cofe-chat-header {
      padding:12px 16px; background:#151528; border-bottom:1px solid #2a2a4a;
      display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
    }
    #cofe-chat-header h3 { margin:0; font-size:14px; font-weight:700; color:#e2e8f0; }
    #cofe-chat-header h3 span { color:#f6ad55; }
    #cofe-chat-header button {
      background:transparent; border:none; color:#8aa0cc; font-size:18px;
      cursor:pointer; padding:0 4px; transition:color .15s;
    }
    #cofe-chat-header button:hover { color:#fff; }

    #cofe-chat-messages {
      flex:1; overflow-y:auto; padding:12px 16px; display:flex; flex-direction:column; gap:10px;
      scrollbar-width:thin; scrollbar-color:#2a2a4a transparent;
    }
    .chat-msg {
      max-width:85%; padding:10px 14px; border-radius:10px; font-size:13px;
      line-height:1.5; word-wrap:break-word; white-space:pre-wrap;
    }
    .chat-msg.user {
      align-self:flex-end; background:#3b82f6; color:#fff; border-bottom-right-radius:4px;
    }
    .chat-msg.assistant {
      align-self:flex-start; background:#2a2a4a; color:#e2e8f0; border-bottom-left-radius:4px;
    }
    .chat-msg.system {
      align-self:center; background:transparent; color:#64748b; font-size:11px;
      text-align:center; padding:4px 8px;
    }
    .chat-msg.error {
      align-self:center; background:#5f1e1e; color:#fca5a5; font-size:12px;
      border:1px solid #ef4444; text-align:center;
    }
    .chat-typing { align-self:flex-start; color:#8aa0cc; font-size:12px; padding:6px 0; }
    .chat-typing span { animation:blink 1.2s infinite; }
    .chat-typing span:nth-child(2) { animation-delay:.2s; }
    .chat-typing span:nth-child(3) { animation-delay:.4s; }
    @keyframes blink { 0%,80%{opacity:.2} 40%{opacity:1} }

    #cofe-chat-input-area {
      padding:10px 12px; background:#0b1220; border-top:1px solid #2a2a4a;
      display:flex; gap:8px; flex-shrink:0;
    }
    #cofe-chat-input {
      flex:1; background:#1e1e2e; border:1px solid #3a3a5c; border-radius:8px;
      padding:8px 12px; color:#e2e8f0; font-size:13px; font-family:inherit;
      resize:none; outline:none; min-height:36px; max-height:80px;
    }
    #cofe-chat-input::placeholder { color:#64748b; }
    #cofe-chat-input:focus { border-color:#3b82f6; }
    #cofe-chat-send {
      background:#3b82f6; border:none; border-radius:8px; color:#fff;
      width:36px; height:36px; cursor:pointer; font-size:16px; flex-shrink:0;
      display:flex; align-items:center; justify-content:center; transition:background .15s;
    }
    #cofe-chat-send:hover { background:#2563eb; }
    #cofe-chat-send:disabled { background:#2a2a4a; cursor:not-allowed; }

    @media(max-width:500px) {
      #cofe-chat-panel { width:calc(100vw - 16px); right:8px; bottom:78px; height:60vh; }
      #cofe-chat-btn { bottom:16px; right:16px; width:46px; height:46px; font-size:20px; }
    }
  `;
  document.head.appendChild(style);

  /* ---- inject HTML ---- */
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <button id="cofe-chat-btn" title="Chat with AI">&#x1F4AC;</button>
    <div id="cofe-chat-panel">
      <div id="cofe-chat-header">
        <h3><span>COFE</span> AI Analyst</h3>
        <button id="cofe-chat-close" title="Close">&times;</button>
      </div>
      <div id="cofe-chat-messages">
        <div class="chat-msg system">Ask me about comps, pricing trends, cap rates, or any deal in the database.</div>
      </div>
      <div id="cofe-chat-input-area">
        <textarea id="cofe-chat-input" placeholder="Ask about comps, markets, deals..." rows="1"></textarea>
        <button id="cofe-chat-send" title="Send">&#x27A4;</button>
      </div>
    </div>`;
  document.body.appendChild(wrapper);

  const btn = document.getElementById('cofe-chat-btn');
  const panel = document.getElementById('cofe-chat-panel');
  const closeBtn = document.getElementById('cofe-chat-close');
  const input = document.getElementById('cofe-chat-input');
  const sendBtn = document.getElementById('cofe-chat-send');
  const messages = document.getElementById('cofe-chat-messages');

  let compData = null;
  let conversationHistory = [];

  /* ---- toggle ---- */
  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  });
  closeBtn.addEventListener('click', () => panel.classList.remove('open'));

  /* ---- auto-resize textarea ---- */
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 80) + 'px';
  });

  /* ---- send ---- */
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    if (ANTHROPIC_API_KEY === 'REPLACE_WITH_API_KEY') {
      addMsg('error', 'API key not configured. Edit the ANTHROPIC_API_KEY variable in chat.js.');
      return;
    }

    addMsg('user', text);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    /* load comp data on first message */
    if (!compData) {
      try {
        const resp = await fetch('data.json');
        compData = await resp.json();
      } catch (e) {
        addMsg('error', 'Failed to load comp data.');
        sendBtn.disabled = false;
        return;
      }
    }

    /* smart filter: find relevant comps based on user query */
    const context = buildContext(text);

    const typing = document.createElement('div');
    typing.className = 'chat-typing';
    typing.innerHTML = '<span>.</span><span>.</span><span>.</span> Thinking';
    messages.appendChild(typing);
    messages.scrollTop = messages.scrollHeight;

    conversationHistory.push({ role: 'user', content: text });

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT + '\n\n## Comp Database Context\n' + context,
          messages: conversationHistory
        })
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${resp.status}`);
      }

      const data = await resp.json();
      const reply = data.content?.[0]?.text || 'No response.';
      conversationHistory.push({ role: 'assistant', content: reply });
      typing.remove();
      addMsg('assistant', reply);
    } catch (e) {
      typing.remove();
      addMsg('error', 'Error: ' + e.message);
      conversationHistory.pop(); // remove failed user message from history
    }

    sendBtn.disabled = false;
    input.focus();
  }

  /* ---- smart context builder ---- */
  function buildContext(query) {
    const q = query.toLowerCase();

    /* detect market from query */
    let matchedMarket = null;
    for (const [market, keywords] of Object.entries(MARKET_KEYWORDS)) {
      if (keywords.some(kw => q.includes(kw))) { matchedMarket = market; break; }
    }

    /* detect layer type from query */
    let typeFilter = null;
    if (/\b(sale|sold|bought|purchase)\b/i.test(q)) typeFilter = ['ind_sale', 'ios_sale'];
    else if (/\b(lease|rent|tenant)\b/i.test(q)) typeFilter = ['ind_lease', 'ios_rent'];
    else if (/\b(pipeline|deal|under contract|loi)\b/i.test(q)) typeFilter = ['ios_pipeline'];
    else if (/\b(owned|cofe asset|our propert)/i.test(q)) typeFilter = ['cofe_owned', 'cofe_sold'];
    else if (/\bios\b/i.test(q)) typeFilter = ['ios_sale', 'ios_rent', 'ios_pipeline'];

    /* filter comps */
    let filtered = compData;

    if (matchedMarket) {
      const kws = MARKET_KEYWORDS[matchedMarket];
      filtered = filtered.filter(c => {
        const txt = ((c.m || '') + ' ' + (c.sm || '') + ' ' + (c.a || '')).toLowerCase();
        return kws.some(kw => txt.includes(kw));
      });
    }

    if (typeFilter) {
      filtered = filtered.filter(c => typeFilter.includes(c.l));
    }

    /* if still too many, take the most recent 150 */
    if (filtered.length > 150) {
      filtered.sort((a, b) => (b.dt || '').localeCompare(a.dt || ''));
      filtered = filtered.slice(0, 150);
    }

    /* if no filters matched, send a summary instead of everything */
    if (!matchedMarket && !typeFilter) {
      filtered.sort((a, b) => (b.dt || '').localeCompare(a.dt || ''));
      filtered = filtered.slice(0, 100);
    }

    /* format comps compactly */
    const lines = filtered.map(c => {
      const parts = [LAYER_LABELS[c.l] || c.l];
      if (c.a) parts.push(c.a);
      if (c.m) parts.push(c.m);
      if (c.dt) parts.push(c.dt);
      if (c.sf) parts.push(c.sf);
      if (c.p) parts.push(c.p);
      if (c.psf) parts.push(c.psf);
      if (c.cap) parts.push('Cap: ' + c.cap);
      if (c.cls) parts.push('Class ' + c.cls);
      if (c.status) parts.push(c.status);
      if (c.rent) parts.push('Rent: ' + c.rent);
      return parts.join(' | ');
    });

    const header = `${filtered.length} comps returned` +
      (matchedMarket ? ` (market: ${matchedMarket})` : '') +
      (typeFilter ? ` (type: ${typeFilter.join(', ')})` : '') +
      ` out of ${compData.length} total in database.\n`;

    return header + lines.join('\n');
  }

  /* ---- helpers ---- */
  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }
})();
