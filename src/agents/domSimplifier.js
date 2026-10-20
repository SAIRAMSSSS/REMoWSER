// src/agents/domSimplifier.js
/**
 * DOM Simplification Engine & High-Accuracy Intent Detector
 * Injected into active and background pages via Playwright.
 * Strips non-content elements, identifies interactables with REMOWSER_ID,
 * extracts pricing and search result snippets, and returns a token-efficient representation.
 */
(() => {
  // 1️⃣ Security Boundaries & Human-in-the-Loop Detection
  const securityAnalysis = {
    hasCaptcha: false,
    hasLoginForm: false,
    hasCheckoutForm: false,
    securityReason: ''
  };

  // Detect CAPTCHAs
  const captchaSelectors = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="arkoselabs"]',
    '#cf-turnstile',
    '.cf-turnstile',
    '.g-recaptcha',
    '.h-captcha',
    '[data-sitekey]'
  ];
  for (const sel of captchaSelectors) {
    if (document.querySelector(sel)) {
      securityAnalysis.hasCaptcha = true;
      securityAnalysis.securityReason = `Captcha widget detected (${sel})`;
      break;
    }
  }

  if (!securityAnalysis.hasCaptcha) {
    const pageText = document.body ? document.body.innerText.toLowerCase() : '';
    if (
      pageText.includes('verify you are human') ||
      pageText.includes('checking your browser') ||
      pageText.includes('security check to continue') ||
      pageText.includes('please complete the captcha')
    ) {
      securityAnalysis.hasCaptcha = true;
      securityAnalysis.securityReason = 'Verification challenge detected in page text';
    }
  }

  // Detect Password / Login
  const passwordInput = document.querySelector('input[type="password"]');
  if (passwordInput) {
    securityAnalysis.hasLoginForm = true;
    securityAnalysis.securityReason = 'Password input detected (Authentication required)';
  }

  // Detect Checkout / Payment Buttons
  const checkoutKeywords = ['checkout', 'place order', 'buy now', 'pay now', 'confirm purchase'];
  const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]'));
  for (const btn of allButtons) {
    const text = (btn.textContent || btn.getAttribute('value') || '').toLowerCase().trim();
    if (checkoutKeywords.some(kw => text === kw || text.includes(` ${kw}`) || text.includes(`${kw} `))) {
      securityAnalysis.hasCheckoutForm = true;
      securityAnalysis.securityReason = `Critical payment action detected: "${text}"`;
      break;
    }
  }

  // 2️⃣ Helper for element visibility
  const isElementVisible = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      style.pointerEvents === 'none'
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    if (rect.bottom < -100 || rect.top > (window.innerHeight + 3000)) return false;
    return true;
  };

  // 3️⃣ Find and Rank Interactable Elements
  const junkLinkTexts = [
    'privacy', 'terms', 'cookies', 'sign in', 'log in', 'help',
    'feedback', 'advertising', 'about', 'settings', 'consumer information',
    'all rights reserved', 'skip to content', 'language'
  ];

  const interactableQuery = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const rawInteractables = Array.from(document.querySelectorAll(interactableQuery));
  const scoredInteractables = [];
  let idCounter = 1;

  function decodeBingUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    if (!rawUrl.includes('bing.com/ck/a')) return rawUrl;
    try {
      const match = rawUrl.match(/[?&]u=a1([a-zA-Z0-9_\-]+)/);
      if (match) {
        let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return atob(b64);
      }
    } catch (e) {}
    return rawUrl;
  }

  // 3️⃣ Extract Structured Search Engine Results First (Bing / Google / GitHub)
  const searchCards = document.querySelectorAll('li.b_algo, .g, [data-sokoban-container], .b_ans, .repo-list-item');
  const structuredResults = [];
  const assignedElements = new Set();

  for (const card of searchCards) {
    const titleEl = card.querySelector('h2 a, h3 a, [role="heading"] a') || card.querySelector('a');
    const snippetEl = card.querySelector('.b_caption p, p.b_algoSlug, .b_snippet, .VwiC3b, p');
    if (titleEl) {
      const title = (titleEl.textContent || titleEl.innerText || '').replace(/\s+/g, ' ').trim();
      let rawHref = titleEl.getAttribute('href') || (titleEl.href || (titleEl.closest('a') ? (titleEl.closest('a').getAttribute('href') || titleEl.closest('a').href) : '')) || '';
      let cleanHref = decodeBingUrl(rawHref);
      if (!cleanHref || cleanHref.includes('bing.com/ck/a')) {
        const citeEl = card.querySelector('cite');
        if (citeEl) {
          const citeText = (citeEl.textContent || citeEl.innerText || '').replace(/\s+/g, ' ').replace(/ › /g, '/').trim();
          if (citeText.startsWith('http')) cleanHref = citeText;
          else if (citeText.includes('github.com')) cleanHref = 'https://' + citeText;
        }
      }

      const remId = idCounter++;
      titleEl.setAttribute('data-remowser-id', remId.toString());
      assignedElements.add(titleEl);

      const snippet = snippetEl ? (snippetEl.textContent || snippetEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
      if (title && title.length > 3) {
        structuredResults.push(`🔎 [Result #${remId}]: "${title}"\n   Link: ${cleanHref}\n   Snippet: ${snippet}`);
        
        scoredInteractables.push({
          id: remId,
          priority: 9,
          tag: 'a',
          text: title.length > 80 ? title.slice(0, 77) + '...' : title,
          href: cleanHref
        });
      }
    }
    if (structuredResults.length >= 8) break;
  }

  // 4️⃣ Process Remaining Page Interactables
  for (const el of rawInteractables) {
    if (!isElementVisible(el)) continue;
    if (assignedElements.has(el)) continue;

    // Skip hidden inputs
    if (el.tagName.toLowerCase() === 'input' && el.getAttribute('type') === 'hidden') continue;

    let text = (el.innerText || el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const lowerText = text.toLowerCase();

    // Filter out common low-value footer / cookie links
    if (junkLinkTexts.some(j => lowerText === j || (lowerText.length < 25 && lowerText.includes(j)))) {
      continue;
    }

    if (text.length > 90) text = text.slice(0, 87) + '...';

    // Assign unique REMOWSER_ID
    const remowserId = idCounter++;
    el.setAttribute('data-remowser-id', remowserId.toString());

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const name = el.getAttribute('name') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    let href = el.getAttribute('href') || (tag === 'a' ? el.href : '') || '';
    if (href) href = decodeBingUrl(href);
    const val = (el.value && type !== 'password') ? el.value : '';

    // Score importance: Inputs & Buttons get top priority
    let priority = 1;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') priority = 10;
    else if (tag === 'button' || el.getAttribute('role') === 'button') priority = 8;
    else if (text.length > 5) priority = 5;

    scoredInteractables.push({
      id: remowserId,
      priority,
      tag,
      type: type || undefined,
      text: text || undefined,
      name: name || undefined,
      placeholder: placeholder || undefined,
      value: val || undefined,
      href: (href && href.length < 120 && !href.startsWith('javascript:')) ? href : undefined
    });

    if (scoredInteractables.length >= 60) break;
  }

  // Sort by priority so search results, inputs, and main buttons appear first
  scoredInteractables.sort((a, b) => b.priority - a.priority);
  const topInteractables = scoredInteractables.slice(0, 45);

  // 5️⃣ Extract Meaningful Content Snippets (Results, Paragraphs, Prices)
  const contentSnippets = [];
  
  // Look for price patterns on e-commerce or search pages
  const priceRegex = /([$€₹£¥]\s*\d+([.,]\d{2})?|\b\d+([.,]\d{2})?\s*(USD|EUR|INR|GBP)\b)/i;
  const allTextElements = document.querySelectorAll('h1, h2, h3, p, li, [role="heading"], article, .price, [class*="price"], [class*="result"]');

  for (const node of allTextElements) {
    if (!isElementVisible(node)) continue;
    const txt = (node.innerText || '').replace(/\s+/g, ' ').trim();
    if (txt.length > 10 && txt.length < 350) {
      if (priceRegex.test(txt)) {
        contentSnippets.push(`💰 [Price Found]: ${txt}`);
      } else if (node.tagName.startsWith('H') || node.getAttribute('role') === 'heading') {
        contentSnippets.push(`📌 [Heading]: ${txt}`);
      } else {
        contentSnippets.push(`- ${txt}`);
      }
    }
    if (contentSnippets.length >= 40) break;
  }

  // 6️⃣ Construct Clean, Concise Representation for REMO
  const pageTitle = document.title || 'Untitled Page';
  const pageUrl = window.location.href;

  const elementsSummary = topInteractables.map(item => {
    const parts = [`[#${item.id}] <${item.tag}`];
    if (item.type) parts.push(`type="${item.type}"`);
    if (item.name) parts.push(`name="${item.name}"`);
    if (item.placeholder) parts.push(`placeholder="${item.placeholder}"`);
    if (item.href) parts.push(`href="${item.href}"`);
    parts.push('>');
    if (item.text) parts.push(` "${item.text}"`);
    if (item.value) parts.push(` (value: "${item.value}")`);
    return parts.join(' ');
  }).join('\n');

  const formattedContext = [
    `# Current Page: "${pageTitle}"`,
    `URL: ${pageUrl}`,
    '',
    structuredResults.length > 0 ? '## Structured Search Results:\n' + structuredResults.join('\n\n') + '\n' : '',
    '## Interactive Elements (Use [#ID] in action):',
    elementsSummary || '(No interactive elements found on current viewport)',
    '',
    '## Visible Page Content & Results:',
    contentSnippets.join('\n') || (document.body ? document.body.innerText.slice(0, 2500).replace(/\s+/g, ' ') : '')
  ].filter(Boolean).join('\n');

  return {
    title: pageTitle,
    url: pageUrl,
    interactablesCount: topInteractables.length,
    security: securityAnalysis,
    domContext: formattedContext
  };
})();
