/* ============================================================
   COFE Properties — AI Chat Widget  (chat.js)
   Drop <script src="chat.js"></script> before </body> on any page.
   ============================================================ */

/* Set this to your deployed Cloudflare Worker URL */
const CHAT_PROXY_URL = 'https://cofe-chat-proxy.ejcosculluela26.workers.dev';
const CHAT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONTEXT_COMPS = 200;
const NEARBY_MILES = 5;

const SYSTEM_PROMPT = `You are a CRE analyst for COFE Properties. You have access to a filtered subset of the company's industrial comp database (1,400+ comps across Houston, DFW, Miami, Orlando, Tampa, Atlanta, Charlotte, Charleston, Jacksonville, San Antonio, and Austin). The database includes industrial sale comps, lease comps, IOS sale comps, IOS rent comps, deal pipeline, and owned assets.

The comps provided are filtered to be relevant to the user's question — either nearby the selected property (within 5 miles), matching the market they asked about, or a market-level summary. Always cite specific comp data with addresses, prices, and dates. Be concise.

If the user has a property selected on the map, you'll see it noted at the start of their message. Use that context to find nearby comps, analyze pricing, and give investment opinions.`;

/* ---- layer-type labels ---- */
const LAYER_LABELS = {
  ind_sale: 'Industrial Sale', ind_lease: 'Industrial Lease',
  ios_sale: 'IOS Sale', ios_rent: 'IOS Rent',
  ios_pipeline: 'IOS Pipeline', cofe_owned: 'COFE Owned', cofe_sold: 'COFE Sold'
};

/* ---- market keyword map for query detection ---- */
const MARKET_KEYWORDS = {
  Houston: ['houston','sugar land','katy','pasadena','baytown','spring','humble','cypress','tomball','pearland','league city','webster','friendswood','missouri city','stafford','bellaire'],
  DFW: ['dallas','fort worth','dfw','arlington','irving','plano','frisco','mckinney','denton','carrollton','lewisville','garland','richardson','grand prairie','mesquite','haltom','richland hills'],
  Miami: ['miami','doral','medley','hialeah','opa-locka','deerfield','pompano','fort lauderdale','oakland park','coral springs','dania','hollywood','pembroke','davie','sunrise','plantation','boca raton','boynton','delray','west palm','south florida'],
  'San Antonio': ['san antonio','new braunfels','schertz','converse','live oak','selma'],
  Austin: ['austin','round rock','pflugerville','cedar park','georgetown','san marcos','kyle','buda'],
  Atlanta: ['atlanta','kennesaw','marietta','norcross','duluth','lawrenceville','mcdonough','lithia springs','college park','peachtree','alpharetta','roswell','smyrna','tucker'],
  Orlando: ['orlando','kissimmee','sanford','apopka','ocoee','winter park','lake mary','altamonte'],
  Tampa: ['tampa','st petersburg','clearwater','brandon','lakeland','plant city','riverview','wesley chapel'],
  Charlotte: ['charlotte','concord','huntersville','mooresville','gastonia','rock hill','matthews','mint hill'],
  Charleston: ['charleston','north charleston','mount pleasant','summerville','goose creek','hanahan'],
  Jacksonville: ['jacksonville','orange park','st augustine','fernandina','ponte vedra']
};

/* ---- active property (set from map when user clicks a pin) ---- */
let _activeProperty = null;

/**
 * Call this from the map when a comp pin is clicked.
 * Stores the comp so the chat can reference it.
 */
function setActiveProperty(comp) {
  _activeProperty = comp || null;
}

(function() {
  /* ---- default & min/max sizes ---- */
  const DEF_W = 480, DEF_H = 600;
  const MIN_W = 350, MIN_H = 400;

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
      width:${DEF_W}px; height:${DEF_H}px; max-height:calc(100vh - 110px);
      background:#1e1e2e; border:1px solid #2a2a4a; border-radius:12px;
      display:none; flex-direction:column; overflow:hidden;
      box-shadow:0 8px 40px rgba(0,0,0,0.5);
      transition: width 0.2s, height 0.2s, top 0.2s, left 0.2s, right 0.2s, bottom 0.2s;
    }
    #cofe-chat-panel.open { display:flex; }
    #cofe-chat-panel.maximized {
      width:90vw !important; height:85vh !important;
      top:50% !important; left:50% !important;
      right:auto !important; bottom:auto !important;
      transform:translate(-50%,-50%); max-height:85vh;
    }
    #cofe-chat-panel.dragging { transition:none; }

    /* Resize handle — top-left corner */
    #cofe-chat-resize {
      position:absolute; top:0; left:0; width:16px; height:16px;
      cursor:nw-resize; z-index:10;
    }
    #cofe-chat-resize::after {
      content:''; position:absolute; top:3px; left:3px;
      width:8px; height:8px; border-top:2px solid #3a3a5c; border-left:2px solid #3a3a5c;
      transition:border-color .15s;
    }
    #cofe-chat-resize:hover::after { border-color:#8aa0cc; }

    #cofe-chat-header {
      padding:12px 16px; background:#151528; border-bottom:1px solid #2a2a4a;
      display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
    }
    #cofe-chat-header h3 { margin:0; font-size:14px; font-weight:700; color:#e2e8f0; }
    #cofe-chat-header h3 span { color:#f6ad55; }
    .cofe-chat-header-btns { display:flex; gap:2px; }
    .cofe-chat-header-btns button {
      background:transparent; border:none; color:#8aa0cc; font-size:16px;
      cursor:pointer; padding:2px 6px; transition:color .15s; border-radius:4px;
    }
    .cofe-chat-header-btns button:hover { color:#fff; background:#2a2a4a; }

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
      #cofe-chat-panel { width:calc(100vw - 16px) !important; right:8px !important; bottom:78px !important; height:60vh !important; }
      #cofe-chat-btn { bottom:16px; right:16px; width:46px; height:46px; font-size:20px; }
      #cofe-chat-resize { display:none; }
    }
  `;
  document.head.appendChild(style);

  /* ---- inject HTML ---- */
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <button id="cofe-chat-btn" title="Chat with AI">&#x1F4AC;</button>
    <div id="cofe-chat-panel">
      <div id="cofe-chat-resize"></div>
      <div id="cofe-chat-header">
        <h3><span>COFE</span> AI Analyst</h3>
        <div class="cofe-chat-header-btns">
          <button id="cofe-chat-max" title="Maximize">&#x2922;</button>
          <button id="cofe-chat-close" title="Close">&times;</button>
        </div>
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
  const maxBtn = document.getElementById('cofe-chat-max');
  const resizeHandle = document.getElementById('cofe-chat-resize');
  const input = document.getElementById('cofe-chat-input');
  const sendBtn = document.getElementById('cofe-chat-send');
  const messages = document.getElementById('cofe-chat-messages');

  let compData = null;
  let conversationHistory = [];
  let isMaximized = false;

  /* ---- toggle ---- */
  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  });
  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open', 'maximized');
    isMaximized = false;
    maxBtn.innerHTML = '&#x2922;';
    maxBtn.title = 'Maximize';
  });

  /* ---- maximize / restore ---- */
  maxBtn.addEventListener('click', () => {
    isMaximized = !isMaximized;
    if (isMaximized) {
      panel.classList.add('maximized');
      maxBtn.innerHTML = '&#x2923;';
      maxBtn.title = 'Restore';
    } else {
      panel.classList.remove('maximized');
      maxBtn.innerHTML = '&#x2922;';
      maxBtn.title = 'Maximize';
    }
  });

  /* ---- resize by dragging top-left corner ---- */
  (function() {
    let dragging = false, startX, startY, startW, startH, startRight, startBottom;

    resizeHandle.addEventListener('mousedown', startDrag);
    resizeHandle.addEventListener('touchstart', startDrag, { passive: false });

    function startDrag(e) {
      if (isMaximized) return;
      e.preventDefault();
      dragging = true;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const rect = panel.getBoundingClientRect();
      startX = clientX;
      startY = clientY;
      startW = rect.width;
      startH = rect.height;
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      panel.classList.add('dragging');
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);
      document.addEventListener('touchmove', onDrag, { passive: false });
      document.addEventListener('touchend', stopDrag);
    }

    function onDrag(e) {
      if (!dragging) return;
      e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = startX - clientX; // dragging left = wider
      const dy = startY - clientY; // dragging up = taller
      const maxW = window.innerWidth * 0.9;
      const maxH = window.innerHeight * 0.9;
      const newW = Math.max(MIN_W, Math.min(maxW, startW + dx));
      const newH = Math.max(MIN_H, Math.min(maxH, startH + dy));
      panel.style.width = newW + 'px';
      panel.style.height = newH + 'px';
      // Keep bottom-right corner anchored
      panel.style.right = startRight + 'px';
      panel.style.bottom = startBottom + 'px';
    }

    function stopDrag() {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('dragging');
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', stopDrag);
      document.removeEventListener('touchmove', onDrag);
      document.removeEventListener('touchend', stopDrag);
    }
  })();

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

    if (CHAT_PROXY_URL === 'REPLACE_WITH_WORKER_URL') {
      addMsg('error', 'Chat proxy not configured. Set CHAT_PROXY_URL in chat.js to your Cloudflare Worker URL.');
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

    /* build filtered context */
    const { context, compCount } = buildContext(text);
    console.log('COFE Chat: sending ' + compCount + ' comps as context');

    /* build the message content, prepending active property if set */
    let messageContent = text;
    if (_activeProperty) {
      const p = _activeProperty;
      const parts = [];
      if (p.a) parts.push(p.a);
      if (p.m) parts.push(p.m);
      if (p.p) parts.push(p.p);
      if (p.psf) parts.push(p.psf);
      if (p.sf) parts.push(p.sf);
      if (p.cap) parts.push('Cap: ' + p.cap);
      if (p.dt) parts.push('Date: ' + p.dt);
      if (p.cls) parts.push('Class ' + p.cls);
      if (p.l) parts.push(LAYER_LABELS[p.l] || p.l);
      messageContent = `[Currently viewing on map: ${parts.join(', ')}]\n\n${text}`;
    }

    const typing = document.createElement('div');
    typing.className = 'chat-typing';
    typing.innerHTML = '<span>.</span><span>.</span><span>.</span> Thinking';
    messages.appendChild(typing);
    messages.scrollTop = messages.scrollHeight;

    conversationHistory.push({ role: 'user', content: messageContent });

    try {
      const resp = await fetch(CHAT_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CHAT_MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT + '\n\n' + context,
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

  /* ============================================================
     CONTEXT BUILDER — 3-tier filtering strategy
     ============================================================ */

  /**
   * Haversine distance in miles between two lat/lng points.
   */
  function distMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Format a single comp as a pipe-delimited line.
   */
  function formatComp(c) {
    const parts = [LAYER_LABELS[c.l] || c.l];
    if (c.a) parts.push(c.a);
    if (c.m) parts.push(c.m);
    if (c.sm) parts.push(c.sm);
    if (c.dt) parts.push(c.dt);
    if (c.sf) parts.push(c.sf);
    if (c.p) parts.push(c.p);
    if (c.psf) parts.push(c.psf);
    if (c.cap) parts.push('Cap: ' + c.cap);
    if (c.cls) parts.push('Class ' + c.cls);
    if (c.status) parts.push(c.status);
    if (c.rent) parts.push('Rent: ' + c.rent);
    if (c.total_ac) parts.push(c.total_ac + ' AC');
    if (c.target) parts.push('Target: ' + c.target);
    return parts.join(' | ');
  }

  /**
   * Build a market-level summary (fallback when no specific filter applies).
   */
  function buildMarketSummary() {
    const markets = {};
    compData.forEach(c => {
      const m = c.m || 'Unknown';
      if (!markets[m]) markets[m] = { count: 0, layers: {}, prices: [], psfs: [] };
      markets[m].count++;
      markets[m].layers[c.l] = (markets[m].layers[c.l] || 0) + 1;
      if (c.p) {
        const num = parseFloat(c.p.replace(/[$,]/g, ''));
        if (!isNaN(num) && num > 0) markets[m].prices.push(num);
      }
      if (c.psf) {
        const num = parseFloat(c.psf.replace(/[$,/SF]/gi, ''));
        if (!isNaN(num) && num > 0) markets[m].psfs.push(num);
      }
    });

    const lines = [`## Database Summary (${compData.length} total comps)\n`];
    for (const [m, d] of Object.entries(markets).sort((a, b) => b[1].count - a[1].count)) {
      const layerStr = Object.entries(d.layers).map(([l, n]) => `${LAYER_LABELS[l] || l}: ${n}`).join(', ');
      let stats = `${d.count} comps (${layerStr})`;
      if (d.psfs.length > 0) {
        const avg = d.psfs.reduce((a, b) => a + b, 0) / d.psfs.length;
        const min = Math.min(...d.psfs);
        const max = Math.max(...d.psfs);
        stats += ` | PSF: $${min.toFixed(0)}-$${max.toFixed(0)} (avg $${avg.toFixed(0)})`;
      }
      if (d.prices.length > 0) {
        const avg = d.prices.reduce((a, b) => a + b, 0) / d.prices.length;
        stats += ` | Avg Price: $${(avg / 1e6).toFixed(1)}M`;
      }
      lines.push(`${m}: ${stats}`);
    }
    lines.push('\nAsk about a specific market or click a property on the map for detailed comp data.');
    return { context: lines.join('\n'), compCount: 0 };
  }

  /**
   * Main context builder — returns { context, compCount }
   * 1. If a property is selected, find comps within 5 miles
   * 2. If a market/city is detected in the query, filter to that market
   * 3. Fallback: send a market-level summary
   */
  function buildContext(query) {
    const q = query.toLowerCase();
    let filtered = null;
    let filterDesc = '';

    /* --- Tier 1: Nearby comps if a property is selected --- */
    if (_activeProperty && _activeProperty.lat && _activeProperty.lng) {
      const refLat = _activeProperty.lat;
      const refLng = _activeProperty.lng;

      const nearby = compData
        .filter(c => c.lat && c.lng)
        .map(c => ({ ...c, _dist: distMiles(refLat, refLng, c.lat, c.lng) }))
        .filter(c => c._dist <= NEARBY_MILES)
        .sort((a, b) => a._dist - b._dist);

      if (nearby.length > 0) {
        filtered = nearby.slice(0, MAX_CONTEXT_COMPS);
        filterDesc = `## Nearby Comps (within ${NEARBY_MILES} mi of ${_activeProperty.a || 'selected property'}) — ${filtered.length} of ${nearby.length} comps`;
      }
    }

    /* --- Tier 2: Market detection from query --- */
    if (!filtered) {
      for (const [market, keywords] of Object.entries(MARKET_KEYWORDS)) {
        if (keywords.some(kw => q.includes(kw))) {
          const marketComps = compData.filter(c => {
            const txt = ((c.m || '') + ' ' + (c.sm || '') + ' ' + (c.a || '')).toLowerCase();
            return keywords.some(kw => txt.includes(kw));
          });
          if (marketComps.length > 0) {
            marketComps.sort((a, b) => (b.dt || '').localeCompare(a.dt || ''));
            filtered = marketComps.slice(0, MAX_CONTEXT_COMPS);
            filterDesc = `## ${market} Market Comps — ${filtered.length} of ${marketComps.length} comps`;
            break;
          }
        }
      }
    }

    /* --- Also check for layer-type keywords to further refine --- */
    if (filtered) {
      let typeFilter = null;
      if (/\b(sale|sold|bought|purchase)\b/i.test(q)) typeFilter = ['ind_sale', 'ios_sale'];
      else if (/\b(lease|rent|tenant)\b/i.test(q)) typeFilter = ['ind_lease', 'ios_rent'];
      else if (/\b(pipeline|deal|under contract|loi)\b/i.test(q)) typeFilter = ['ios_pipeline'];
      else if (/\b(owned|cofe asset|our propert)/i.test(q)) typeFilter = ['cofe_owned', 'cofe_sold'];
      else if (/\bios\b/i.test(q)) typeFilter = ['ios_sale', 'ios_rent', 'ios_pipeline'];

      if (typeFilter) {
        const typed = filtered.filter(c => typeFilter.includes(c.l));
        if (typed.length > 0) {
          filtered = typed.slice(0, MAX_CONTEXT_COMPS);
          filterDesc += ` (filtered to ${typeFilter.map(t => LAYER_LABELS[t] || t).join(', ')}: ${filtered.length} comps)`;
        }
      }
    }

    /* --- Tier 3: Fallback — market summary --- */
    if (!filtered) {
      return buildMarketSummary();
    }

    /* Format filtered comps */
    const lines = filtered.map(c => {
      let line = formatComp(c);
      if (c._dist !== undefined) line += ` | ${c._dist.toFixed(1)} mi`;
      return line;
    });

    return { context: filterDesc + '\n' + lines.join('\n'), compCount: filtered.length };
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
