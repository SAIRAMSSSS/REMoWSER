// src/agents/domSimplifier.js
/**
 * DOM Simplification Engine & Security Detector Payload
 * Injected into active and background pages via Playwright CDP.
 * Strips non-content elements, identifies interactables with REMOWSER_ID,
 * scans for Security Checkpoints (CAPTCHA, Login, Checkout),
 * and returns a minified token-efficient representation for local LLMs (Qwen/Llama).
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
      securityAnalysis.securityReason = `Captcha widget detected matching '${sel}'`;
      break;
    }
  }

  // Detect textual captcha prompts
  if (!securityAnalysis.hasCaptcha) {
    const pageText = document.body ? document.body.innerText.toLowerCase() : '';
    if (
      pageText.includes('verify you are human') ||
      pageText.includes('verify that you are human') ||
      pageText.includes('checking your browser') ||
      pageText.includes('security check to continue') ||
      pageText.includes('please complete the captcha')
    ) {
      securityAnalysis.hasCaptcha = true;
      securityAnalysis.securityReason = 'Verification prompt detected in page text';
    }
  }

  // Detect Login / Password inputs
  const passwordInput = document.querySelector('input[type="password"]');
  if (passwordInput) {
    securityAnalysis.hasLoginForm = true;
    securityAnalysis.securityReason = 'Password input detected (Authentication checkpoint)';
  }

  // Detect Checkout / Payment Buttons
  const checkoutKeywords = ['checkout', 'place order', 'buy now', 'pay now', 'confirm purchase', 'complete purchase'];
  const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]'));
  for (const btn of allButtons) {
    const text = (btn.textContent || btn.getAttribute('value') || '').toLowerCase().trim();
    if (checkoutKeywords.some(kw => text.includes(kw))) {
      securityAnalysis.hasCheckoutForm = true;
      securityAnalysis.securityReason = `Critical transaction action detected: "${text}"`;
      break;
    }
  }

  // 2️⃣ Helper to determine element visibility
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
    // Element must have some dimension or children with dimension
    if (rect.width === 0 && rect.height === 0) return false;
    // Discard elements positioned far off-screen
    if (rect.bottom < -200 || rect.top > (window.innerHeight + 5000)) return false;
    return true;
  };

  // 3️⃣ Find interactable elements
  const interactableQuery = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]'
  ].join(',');

  const rawInteractables = Array.from(document.querySelectorAll(interactableQuery));
  const interactables = [];
  let idCounter = 1;

  for (const el of rawInteractables) {
    if (!isElementVisible(el)) continue;

    // Filter out hidden inputs
    if (el.tagName.toLowerCase() === 'input' && el.getAttribute('type') === 'hidden') continue;

    // Assign unique REMOWSER_ID
    const remowserId = idCounter++;
    el.setAttribute('data-remowser-id', remowserId.toString());

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const name = el.getAttribute('name') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const href = el.getAttribute('href') || '';
    const value = el.value || '';
    
    // Extract meaningful text
    let text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 80) text = text.slice(0, 77) + '...';

    interactables.push({
      id: remowserId,
      tag,
      type: type || undefined,
      text: text || undefined,
      name: name || undefined,
      placeholder: placeholder || undefined,
      ariaLabel: ariaLabel || undefined,
      value: (type !== 'password' && value) ? value : undefined,
      href: (href && href.length < 120 && !href.startsWith('javascript:')) ? href : undefined
    });

    if (interactables.length >= 150) break; // Token guardrail
  }

  // 4️⃣ Extract compact content summary (Headings, Paragraphs, Lists)
  const contentSnippets = [];
  const textNodes = document.querySelectorAll('h1, h2, h3, p, li, [role="heading"], article');
  for (const node of textNodes) {
    if (!isElementVisible(node)) continue;
    const txt = (node.innerText || '').replace(/\s+/g, ' ').trim();
    if (txt.length > 15 && txt.length < 300) {
      contentSnippets.push(`- ${node.tagName.toLowerCase()}: ${txt}`);
    }
    if (contentSnippets.length >= 25) break;
  }

  // 5️⃣ Construct concise markdown-formatted page context for REMO
  const pageTitle = document.title || 'Untitled Page';
  const pageUrl = window.location.href;

  const elementsSummary = interactables.map(item => {
    const parts = [`[#${item.id}] <${item.tag}`];
    if (item.type) parts.push(`type="${item.type}"`);
    if (item.name) parts.push(`name="${item.name}"`);
    if (item.placeholder) parts.push(`placeholder="${item.placeholder}"`);
    if (item.ariaLabel) parts.push(`label="${item.ariaLabel}"`);
    if (item.href) parts.push(`href="${item.href}"`);
    parts.push('>');
    if (item.text) parts.push(` "${item.text}"`);
    if (item.value) parts.push(` (val: "${item.value}")`);
    return parts.join(' ');
  }).join('\n');

  const formattedContext = [
    `# Current Page: "${pageTitle}"`,
    `URL: ${pageUrl}`,
    '',
    '## Interactive Elements (Reference by [#ID]):',
    elementsSummary || '(No interactive elements found on current viewport)',
    '',
    '## Visible Page Text Excerpt:',
    contentSnippets.join('\n') || document.body.innerText.slice(0, 600).replace(/\s+/g, ' ')
  ].join('\n');

  return {
    title: pageTitle,
    url: pageUrl,
    interactablesCount: interactables.length,
    security: securityAnalysis,
    domContext: formattedContext
  };
})();
