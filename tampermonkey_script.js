// ==UserScript==
// @name         Яндекс Лавка — КБЖУ в каталоге
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Отображает калорийность, белки, жиры и углеводы (КБЖУ) прямо в карточках товаров каталога Яндекс Лавки. Включает кэширование, ограничение частоты запросов для защиты от блокировок и панель настроек.
// @author       Antigravity
// @match        *://*.lavka.yandex.ru/*
// @match        *://*.yandex.ru/lavka/*
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/omatick/Yandex.Lavka/main/tampermonkey_script.js
// @downloadURL  https://raw.githubusercontent.com/omatick/Yandex.Lavka/main/tampermonkey_script.js
// ==/UserScript==

(function() {
  'use strict';

  // --- Настройки по умолчанию ---
  const DEFAULT_SETTINGS = {
    enabled: true,
    requestDelayMs: 1000,// Задержка между запросами для предотвращения капчи/бана
    cacheExpirationDays: 7,
    showPer100g: true,// Показывать КБЖУ на 100 грамм
    showPerPortion: true// Показывать КБЖУ на порцию (если доступно)
  };

  const CACHE_KEY = 'lavka_kbzhu_cache';
  const SETTINGS_KEY = 'lavka_kbzhu_settings';
  const KBZHU_MAX_FONT_SIZE = 10;
  const KBZHU_MIN_FONT_SIZE = 7;
  const KBZHU_FONT_STEP = 0.5;

  const kbzhuResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => entries.forEach(entry => fitKbzhuRows(entry.target)))
    : null;

  // --- Функции для работы с настройками ---
  function getSettings() {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.error('[KbzhuScript] Ошибка чтения настроек:', e);
    }
    return DEFAULT_SETTINGS;
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error('[KbzhuScript] Ошибка сохранения настроек:', e);
    }
  }

  function isKbzhuEnabled() {
    return getSettings().enabled !== false;
  }

  // --- Функции для работы с кэшем ---
  function getCache() {
    try {
      const stored = localStorage.getItem(CACHE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error('[KbzhuScript] Ошибка чтения кэша:', e);
    }
    return {};
  }

  function getFromCache(slug) {
    const cache = getCache();
    const item = cache[slug];
    if (item) {
      const settings = getSettings();
      const age = Date.now() - item.updatedAt;
      const expirationMs = settings.cacheExpirationDays * 24 * 60 * 60 * 1000;
      if (age < expirationMs) {
        return item;
      }
      // Удаляем устаревший элемент
      delete cache[slug];
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch (e) {}
    }
    return null;
  }

  function saveToCache(slug, data) {
    const cache = getCache();
    cache[slug] = {
      ...data,
      updatedAt: Date.now()
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      console.error('[KbzhuScript] Не удалось записать кэш:', e);
    }
  }

  function clearCache() {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch (e) {}
  }

  function getCacheCount() {
    return Object.keys(getCache()).length;
  }

  // --- Вспомогательные функции ---
  function getSlugFromUrl(urlStr) {
    if (!urlStr) return null;
    try {
      const url = new URL(urlStr, window.location.origin);
      const parts = url.pathname.split('/');
      const goodIndex = parts.indexOf('good');
      if (goodIndex !== -1 && parts[goodIndex + 1]) {
        return parts[goodIndex + 1];
      }
    } catch (e) {}
    return null;
  }

  // Рекурсивный поиск pfcTraits в JSON
  function findPfcTraits(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.pfcTraits) return obj.pfcTraits;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const result = findPfcTraits(obj[key]);
        if (result) return result;
      }
    }
    return null;
  }

  // --- Запросы и парсинг ---
  async function fetchProductKbzhu(slug) {
    const response = await fetch(`/good/${slug}`);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const htmlText = await response.text();

    // 1. Метод парсинга из гидратационного JSON Next.js
    const scriptRegex = /<script\s+id="(__react_query_state__-data|storedehydratedstate-data)"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(htmlText)) !== null) {
      const scriptContent = match[2].trim();
      try {
        const data = JSON.parse(scriptContent);
        const traits = findPfcTraits(data);
        if (traits) {
          const kbzhu = {
            calories: { per100g: '', perPortion: '' },
            protein: { per100g: '', perPortion: '' },
            fat: { per100g: '', perPortion: '' },
            carbohydrate: { per100g: '', perPortion: '' }
          };
          traits.forEach(t => {
            if (kbzhu[t.id]) {
              kbzhu[t.id].per100g = t.measures?.per100g || '';
              kbzhu[t.id].perPortion = t.measures?.perPortion || '';
            }
          });
          return kbzhu;
        }
      } catch (e) {}
    }

    // 2. Запасной DOM-метод (парсинг регулярками по HTML, если JSON не найден)
    const domResult = {
      calories: { per100g: '', perPortion: '' },
      protein: { per100g: '', perPortion: '' },
      fat: { per100g: '', perPortion: '' },
      carbohydrate: { per100g: '', perPortion: '' }
    };
    let found = false;
    ['calories', 'protein', 'fat', 'carbohydrate'].forEach(id => {
      const regex = new RegExp(`data-testid="trait-value-${id}"[^>]*>([^<]+)</`, 'i');
      const m = htmlText.match(regex);
      if (m) {
        domResult[id].per100g = m[1].trim();
        found = true;
      }
    });

    return found ? domResult : null;
  }

  // --- Очередь запросов с ограничением частоты (Rate Limiter) ---
  const fetchQueue = [];
  let isProcessingQueue = false;

  function addToQueue(slug) {
    if (!isKbzhuEnabled()) return;
    if (fetchQueue.includes(slug)) return;
    fetchQueue.push(slug);
    triggerQueueProcessing();
  }

  function triggerQueueProcessing() {
    if (!isKbzhuEnabled()) {
      fetchQueue.length = 0;
      isProcessingQueue = false;
      return;
    }
    if (isProcessingQueue) return;
    processNextInQueue();
  }

  async function processNextInQueue() {
    if (!isKbzhuEnabled()) {
      fetchQueue.length = 0;
      isProcessingQueue = false;
      return;
    }

    if (fetchQueue.length === 0) {
      isProcessingQueue = false;
      return;
    }

    isProcessingQueue = true;
    const slug = fetchQueue.shift();

    try {
      const kbzhuData = await fetchProductKbzhu(slug);
      if (!isKbzhuEnabled()) {
        fetchQueue.length = 0;
        isProcessingQueue = false;
        return;
      }
      if (kbzhuData) {
        saveToCache(slug, kbzhuData);
        updateCardsForSlug(slug, kbzhuData, 'done');
      } else {
        updateCardsForSlug(slug, null, 'error');
      }
    } catch (err) {
      if (!isKbzhuEnabled()) {
        fetchQueue.length = 0;
        isProcessingQueue = false;
        return;
      }
      console.error(`[KbzhuScript] Ошибка получения КБЖУ для ${slug}:`, err);
      updateCardsForSlug(slug, null, 'error');
    }

    const settings = getSettings();
    if (settings.enabled === false) {
      fetchQueue.length = 0;
      isProcessingQueue = false;
      return;
    }
    setTimeout(processNextInQueue, settings.requestDelayMs);
  }

  function updateCardsForSlug(slug, kbzhuData, status) {
    if (!isKbzhuEnabled()) return;
    const cards = document.querySelectorAll('[data-testid="product-card"], div[class*="ProductSnippet__"]');
    cards.forEach(card => {
      const link = card.querySelector('a[data-type="product-card-link"]') || card.querySelector('a[href*="/good/"]');
      if (link) {
        const cardSlug = getSlugFromUrl(link.href);
        if (cardSlug === slug) {
          card.setAttribute('data-kbzhu-status', status);
          if (status === 'done' && kbzhuData) {
            renderKbzhu(card, kbzhuData);
          } else if (status === 'error') {
            renderError(card);
          }
        }
      }
    });
  }

  // --- Определение видимости (IntersectionObserver) ---
  const intersectionObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const card = entry.target;
        observer.unobserve(card); // Обрабатываем только один раз

        const status = card.getAttribute('data-kbzhu-status');
        if (status === 'pending') {
          const link = card.querySelector('a[data-type="product-card-link"]') || card.querySelector('a[href*="/good/"]');
          const slug = getSlugFromUrl(link ? link.href : null);
          if (slug) {
            card.setAttribute('data-kbzhu-status', 'loading');
            renderSkeleton(card);
            addToQueue(slug);
          }
        }
      }
    });
  }, {
    rootMargin: '100px', // Начинаем загрузку за 100px до входа в область видимости
    threshold: 0.01
  });

  function fitKbzhuRows(kbzhuBox) {
    kbzhuBox.querySelectorAll('.lavka-kbzhu-row').forEach(row => {
      let fontSize = KBZHU_MAX_FONT_SIZE;
      row.style.setProperty('font-size', `${fontSize}px`, 'important');

      if (!row.clientWidth) return;

      while (row.scrollWidth > row.clientWidth && fontSize > KBZHU_MIN_FONT_SIZE) {
        fontSize = Math.max(KBZHU_MIN_FONT_SIZE, fontSize - KBZHU_FONT_STEP);
        row.style.setProperty('font-size', `${fontSize}px`, 'important');
      }
    });
  }

  function scheduleKbzhuRowsFit(kbzhuBox) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => fitKbzhuRows(kbzhuBox));
    } else {
      fitKbzhuRows(kbzhuBox);
    }

    if (kbzhuResizeObserver) {
      kbzhuResizeObserver.observe(kbzhuBox);
    }
  }

  // --- Отрисовка интерфейса на карточках ---
  function renderKbzhu(card, data) {
    const infoEl = card.querySelector('div[class*="info__"]') || card;
    const titleContainer = card.querySelector('div[class*="TruncatedText__"]') || card.querySelector('h3') || card.querySelector('[data-testid="product-title"]');

    // Удаляем предыдущие блоки, если они есть
    const existing = card.querySelector('.lavka-kbzhu-box');
    if (existing) {
      if (kbzhuResizeObserver) kbzhuResizeObserver.unobserve(existing);
      existing.remove();
    }

    const kbzhuBox = document.createElement('div');
    kbzhuBox.className = 'lavka-kbzhu-box';
    kbzhuBox.setAttribute('style', 'display: flex !important; flex-direction: column !important; gap: 3px !important; position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; height: auto !important; min-height: 0 !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; margin: 6px 0 4px 0 !important; padding: 4px 6px !important; border-radius: 6px !important; background-color: var(--theme-bg-minor, #f5f5f7) !important; color: var(--theme-text-minor, #5d5d64) !important; font-size: 10px !important; font-family: YS Text, system-ui, -apple-system, sans-serif !important; line-height: 1.2 !important; border: 1px solid rgba(0,0,0,0.03) !important; overflow: hidden !important; container-type: inline-size !important; float: none !important; clear: both !important;');

    const settings = getSettings();
    let html = '';

    const hasPortion = data.calories.perPortion || data.protein.perPortion || data.fat.perPortion || data.carbohydrate.perPortion;

    const formatVal = (val, suffix = '', round = false) => {
      if (!val) return '—';
      let num = parseFloat(val.replace(',', '.'));
      if (isNaN(num)) return val;
      if (round) {
        return Math.round(num) + suffix;
      }
      return Number(num.toFixed(1)) + suffix;
    };

    const rowStyle = 'display: flex !important; flex-direction: row !important; align-items: center !important; justify-content: space-between !important; gap: 2px !important; font-size: clamp(7px, 4cqw, 10px) !important; position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; height: auto !important; min-height: 0 !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; overflow: hidden !important; float: none !important; clear: none !important;';
    const labelStyle = 'font-weight: 600 !important; color: var(--theme-text-minor, #5d5d64) !important; min-width: 25px !important; max-width: 32px !important; display: inline-block !important; position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; overflow: hidden !important; white-space: nowrap !important; text-overflow: ellipsis !important; flex-shrink: 0 !important; height: auto !important; line-height: 1.2 !important;';
    const valStyle = 'flex: 0 0 auto !important; min-width: max-content !important; text-align: left !important; white-space: nowrap !important; display: inline-flex !important; align-items: baseline !important; position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; height: auto !important; box-sizing: border-box !important; overflow: visible !important; line-height: 1.2 !important;';
    const bStyle = 'color: var(--theme-text-primary, #212022) !important; font-weight: bold !important; position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; display: inline !important; height: auto !important; width: auto !important;';

    if (settings.showPer100g) {
      html += `
        <div class="lavka-kbzhu-row" style="${rowStyle}">
          <span class="lavka-kbzhu-label" style="${labelStyle}">100г</span>
          <span class="lavka-kbzhu-val" style="${valStyle}">🔥<b style="${bStyle}">${formatVal(data.calories.per100g, '', true)}</b></span>
          <span class="lavka-kbzhu-val" style="${valStyle}">Б<b style="${bStyle}">${formatVal(data.protein.per100g)}</b></span>
          <span class="lavka-kbzhu-val" style="${valStyle}">Ж<b style="${bStyle}">${formatVal(data.fat.per100g)}</b></span>
          <span class="lavka-kbzhu-val" style="${valStyle}">У<b style="${bStyle}">${formatVal(data.carbohydrate.per100g)}</b></span>
        </div>
      `;
    }

    if (settings.showPerPortion && hasPortion) {
      html += `
        <div class="lavka-kbzhu-row" style="${rowStyle}">
          <span class="lavka-kbzhu-label" style="${labelStyle}">Порц</span>
          <span class="lavka-kbzhu-val" style="${valStyle}">🔥<b style="${bStyle}">${formatVal(data.calories.perPortion, '', true)}</b></span>
          <span class="lavka-kbzhu-val" style="${valStyle}">Б<b style="${bStyle}">${formatVal(data.protein.perPortion)}</b></span>
          <span class="lavka-kbzhu-val" style="${valStyle}">Ж<b style="${bStyle}">${formatVal(data.fat.perPortion)}</b></span>
          <span class="lavka-kbzhu-val" style="${valStyle}">У<b style="${bStyle}">${formatVal(data.carbohydrate.perPortion)}</b></span>
        </div>
      `;
    }

    if (!html) return; // Если всё выключено в настройках

    kbzhuBox.innerHTML = html;

    if (titleContainer && titleContainer.parentNode) {
      titleContainer.parentNode.insertBefore(kbzhuBox, titleContainer.nextSibling);
    } else {
      infoEl.appendChild(kbzhuBox);
    }
    scheduleKbzhuRowsFit(kbzhuBox);
  }

  function renderSkeleton(card) {
    const titleContainer = card.querySelector('div[class*="TruncatedText__"]') || card.querySelector('h3') || card.querySelector('[data-testid="product-title"]');
    if (!titleContainer) return;

    if (card.querySelector('.lavka-kbzhu-box')) return;

    const skeleton = document.createElement('div');
    skeleton.className = 'lavka-kbzhu-box lavka-kbzhu-skeleton';
    skeleton.setAttribute('style', 'display: flex !important; justify-content: center !important; align-items: center !important; position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; height: auto !important; min-height: 0 !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; margin: 6px 0 4px 0 !important; padding: 6px !important; border-radius: 6px !important; background-color: var(--theme-bg-minor, #f5f5f7) !important; border: 1px solid rgba(0,0,0,0.03) !important; overflow: hidden !important;');
    skeleton.innerHTML = `<div class="lavka-kbzhu-skeleton-pulse" style="animation: lavka-kbzhu-pulse 1.5s infinite ease-in-out !important; font-weight: 500 !important; text-align: center !important; color: var(--theme-text-minor, #5d5d64) !important; width: 100% !important; display: block !important; font-size: 10px !important; position: relative !important; left: auto !important; top: auto !important; height: auto !important; line-height: 1.2 !important;">КБЖУ: загрузка...</div>`;

    titleContainer.parentNode.insertBefore(skeleton, titleContainer.nextSibling);
  }

  function renderError(card) {
    const existing = card.querySelector('.lavka-kbzhu-box');
    if (existing) {
      existing.innerHTML = '<div style="text-align: center; color: var(--theme-text-minor, #EF544A); font-weight: 500;">⚠️ Не удалось загрузить КБЖУ</div>';
      // Удаляем блок ошибки через 4 секунды, чтобы дать возможность повторного сканирования
      setTimeout(() => {
        if (card.getAttribute('data-kbzhu-status') === 'error') {
          card.removeAttribute('data-kbzhu-status');
          existing.remove();
        }
      }, 4000);
    }
  }

  // --- Обработка карточек ---
  function processCard(card) {
    if (!isKbzhuEnabled()) return;
    if (card.getAttribute('data-kbzhu-status')) return;

    const link = card.querySelector('a[data-type="product-card-link"]') || card.querySelector('a[href*="/good/"]');
    if (!link) return;

    const slug = getSlugFromUrl(link.href);
    if (!slug) return;

    card.setAttribute('data-kbzhu-status', 'pending');

    const cachedData = getFromCache(slug);
    if (cachedData) {
      renderKbzhu(card, cachedData);
      card.setAttribute('data-kbzhu-status', 'done');
      return;
    }

    // Если нет в кэше, отправляем на IntersectionObserver
    intersectionObserver.observe(card);
  }

  function removeKbzhuFromCards() {
    fetchQueue.length = 0;
    isProcessingQueue = false;
    document.querySelectorAll('[data-testid="product-card"], div[class*="ProductSnippet__"]').forEach(card => {
      intersectionObserver.unobserve(card);
      card.removeAttribute('data-kbzhu-status');
      const box = card.querySelector('.lavka-kbzhu-box');
      if (box) {
        if (kbzhuResizeObserver) kbzhuResizeObserver.unobserve(box);
        box.remove();
      }
    });
  }

  function scanForCards() {
    if (!isKbzhuEnabled()) {
      removeKbzhuFromCards();
      return;
    }
    const cards = document.querySelectorAll('[data-testid="product-card"], div[class*="ProductSnippet__"]');
    cards.forEach(processCard);
  }

  // --- Внедрение стилей CSS ---
  function injectStyles() {
    if (document.getElementById('lavka-kbzhu-styles')) return;

    const style = document.createElement('style');
    style.id = 'lavka-kbzhu-styles';
    style.textContent = `
      div[class*="ProductSnippet__"] .lavka-kbzhu-box,
      div[data-testid="product-card"] .lavka-kbzhu-box {
        margin-top: 6px !important;
        margin-bottom: 4px !important;
        padding: 4px 6px !important;
        border-radius: 6px !important;
        font-size: 10px !important;
        font-family: YS Text, system-ui, -apple-system, sans-serif !important;
        line-height: 1.2 !important;
        background-color: var(--theme-bg-minor, #f5f5f7) !important;
        color: var(--theme-text-minor, #5d5d64) !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 3px !important;
        border: 1px solid rgba(0,0,0,0.03) !important;
        box-sizing: border-box !important;
        position: relative !important;
        left: auto !important;
        right: auto !important;
        top: auto !important;
        bottom: auto !important;
        height: auto !important;
        min-height: 0 !important;
        width: 100% !important;
        max-width: 100% !important;
        overflow: hidden !important;
        container-type: inline-size !important;
      }
      
      div[class*="ProductSnippet__"] .lavka-kbzhu-row,
      div[data-testid="product-card"] .lavka-kbzhu-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 2px !important;
        font-size: clamp(7px, 4cqw, 10px) !important;
        position: relative !important;
        left: auto !important;
        right: auto !important;
        top: auto !important;
        bottom: auto !important;
        height: auto !important;
        min-height: 0 !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
      }
      
      div[class*="ProductSnippet__"] .lavka-kbzhu-label,
      div[data-testid="product-card"] .lavka-kbzhu-label {
        font-weight: 600 !important;
        color: var(--theme-text-minor, #5d5d64) !important;
        min-width: 25px !important;
        max-width: 32px !important;
        display: inline-block !important;
        position: relative !important;
        left: auto !important;
        right: auto !important;
        top: auto !important;
        bottom: auto !important;
        overflow: hidden !important;
        white-space: nowrap !important;
        text-overflow: ellipsis !important;
        flex-shrink: 0 !important;
        height: auto !important;
        line-height: 1.2 !important;
      }
      
      div[class*="ProductSnippet__"] .lavka-kbzhu-val,
      div[data-testid="product-card"] .lavka-kbzhu-val {
        flex: 0 0 auto !important;
        min-width: max-content !important;
        text-align: left !important;
        white-space: nowrap !important;
        display: inline-flex !important;
        align-items: baseline !important;
        position: relative !important;
        left: auto !important;
        right: auto !important;
        top: auto !important;
        bottom: auto !important;
        height: auto !important;
        box-sizing: border-box !important;
        overflow: visible !important;
        line-height: 1.2 !important;
      }
      
      div[class*="ProductSnippet__"] .lavka-kbzhu-val b,
      div[data-testid="product-card"] .lavka-kbzhu-val b {
        color: var(--theme-text-primary, #212022) !important;
        font-weight: bold !important;
        position: relative !important;
        left: auto !important;
        right: auto !important;
        top: auto !important;
        bottom: auto !important;
        display: inline !important;
        height: auto !important;
        width: auto !important;
      }
      
      @keyframes lavka-kbzhu-pulse {
        0% { opacity: 0.6; }
        50% { opacity: 1; }
        100% { opacity: 0.6; }
      }
      .lavka-kbzhu-skeleton {
        padding: 8px !important;
        justify-content: center !important;
        align-items: center !important;
      }
      .lavka-kbzhu-skeleton-pulse {
        animation: lavka-kbzhu-pulse 1.5s infinite ease-in-out !important;
        font-weight: 500 !important;
        text-align: center !important;
        color: var(--theme-text-minor, #5d5d64) !important;
        justify-content: center !important;
      }
      
      /* Плавающая кнопка настроек */
      .lavka-kbzhu-settings-btn {
        position: fixed;
        bottom: 20px;
        left: 20px;
        z-index: 999999;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background-color: var(--theme-bg-primary, #ffffff);
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s ease;
        border: 1px solid rgba(0,0,0,0.08);
      }
      .lavka-kbzhu-settings-btn:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 20px rgba(0,0,0,0.18);
      }
      .lavka-kbzhu-settings-btn svg {
        width: 22px;
        height: 22px;
        fill: var(--theme-text-minor, #5d5d64);
      }
      
      /* Панель настроек */
      .lavka-kbzhu-settings-panel {
        position: fixed;
        bottom: 75px;
        left: 20px;
        z-index: 999999;
        width: 320px;
        background-color: var(--theme-bg-primary, #ffffff);
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.16);
        border: 1px solid rgba(0,0,0,0.08);
        padding: 18px;
        font-family: YS Text, system-ui, -apple-system, sans-serif;
        display: none;
        flex-direction: column;
        gap: 14px;
        color: var(--theme-text-primary, #212022);
        box-sizing: border-box;
      }
      .lavka-kbzhu-settings-panel.active {
        display: flex;
      }
      .lavka-kbzhu-settings-header {
        font-weight: bold;
        font-size: 15px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid rgba(0,0,0,0.08);
        padding-bottom: 10px;
        margin-bottom: 4px;
      }
      .lavka-kbzhu-settings-close {
        cursor: pointer;
        font-size: 18px;
        font-weight: 500;
        color: var(--theme-text-minor, #5d5d64);
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .lavka-kbzhu-setting-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 13px;
      }
      .lavka-kbzhu-setting-row label {
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        user-select: none;
      }
      .lavka-kbzhu-setting-input {
        width: 70px;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid rgba(0,0,0,0.15);
        background-color: var(--theme-bg-primary, #ffffff);
        color: var(--theme-text-primary, #212022);
        font-size: 13px;
        text-align: right;
        box-sizing: border-box;
      }
      .lavka-kbzhu-setting-checkbox {
        cursor: pointer;
        width: 16px;
        height: 16px;
        accent-color: #fce000;
      }
      .lavka-kbzhu-settings-footer {
        margin-top: 6px;
        display: flex;
        justify-content: space-between;
        gap: 10px;
      }
      .lavka-kbzhu-btn {
        flex: 1;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        text-align: center;
        transition: all 0.15s ease;
      }
      .lavka-kbzhu-btn-primary {
        background-color: #fce000;
        color: #000000;
      }
      .lavka-kbzhu-btn-primary:hover {
        background-color: #e5cc00;
      }
      .lavka-kbzhu-btn-secondary {
        background-color: var(--theme-bg-minor, #f5f5f7);
        color: var(--theme-text-primary, #212022);
        border: 1px solid rgba(0,0,0,0.06);
      }
      .lavka-kbzhu-btn-secondary:hover {
        background-color: rgba(0,0,0,0.04);
      }
      .lavka-kbzhu-info-text {
        font-size: 11px;
        color: var(--theme-text-minor, #5d5d64);
        text-align: center;
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);
  }

  // --- Создание панели настроек ---
  function createSettingsUI() {
    if (document.querySelector('.lavka-kbzhu-settings-btn')) return;

    // Плавающая кнопка
    const btn = document.createElement('div');
    btn.className = 'lavka-kbzhu-settings-btn';
    btn.title = 'Настройки КБЖУ';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.13,5.91,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.43-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
      </svg>
    `;

    // Панель настроек
    const panel = document.createElement('div');
    panel.className = 'lavka-kbzhu-settings-panel';

    const settings = getSettings();
    const cacheCount = getCacheCount();

    panel.innerHTML = `
      <div class="lavka-kbzhu-settings-header">
        <span>Настройки КБЖУ</span>
        <span class="lavka-kbzhu-settings-close">&times;</span>
      </div>
      <div class="lavka-kbzhu-setting-row">
        <label for="kbzhu-enabled-chk" style="display: flex !important; align-items: center !important; gap: 8px !important; cursor: pointer !important; font-size: 13px !important; position: relative !important; left: auto !important; top: auto !important; opacity: 1 !important; visibility: visible !important; height: auto !important; width: auto !important; box-sizing: border-box !important; margin: 0 !important; padding: 0 !important;"><input type="checkbox" id="kbzhu-enabled-chk" class="lavka-kbzhu-setting-checkbox" style="display: inline-block !important; position: static !important; opacity: 1 !important; visibility: visible !important; width: 16px !important; height: 16px !important; min-width: 16px !important; min-height: 16px !important; max-width: 16px !important; max-height: 16px !important; margin: 0 8px 0 0 !important; padding: 0 !important; border: 1px solid #ccc !important; clip: auto !important; -webkit-clip-path: none !important; clip-path: none !important; overflow: visible !important; transform: none !important; pointer-events: auto !important; appearance: checkbox !important; -webkit-appearance: checkbox !important; -moz-appearance: checkbox !important; accent-color: #fce000 !important; cursor: pointer !important;" ${settings.enabled !== false ? 'checked' : ''} /> Включить отображение и загрузку КБЖУ</label>
      </div>
      <div class="lavka-kbzhu-setting-row">
        <label for="kbzhu-delay-input" title="Пауза между фоновыми запросами страниц товаров">Задержка запросов (мс):</label>
        <input type="number" id="kbzhu-delay-input" class="lavka-kbzhu-setting-input" min="200" max="10000" step="100" value="${settings.requestDelayMs}" />
      </div>
      <div class="lavka-kbzhu-setting-row">
        <label for="kbzhu-cache-input" title="Срок хранения загруженных КБЖУ в памяти браузера">Время кэша (дней):</label>
        <input type="number" id="kbzhu-cache-input" class="lavka-kbzhu-setting-input" min="1" max="90" value="${settings.cacheExpirationDays}" />
      </div>
      <div class="lavka-kbzhu-setting-row">
        <label for="kbzhu-100g-chk" style="display: flex !important; align-items: center !important; gap: 8px !important; cursor: pointer !important; font-size: 13px !important; position: relative !important; left: auto !important; top: auto !important; opacity: 1 !important; visibility: visible !important; height: auto !important; width: auto !important; box-sizing: border-box !important; margin: 0 !important; padding: 0 !important;"><input type="checkbox" id="kbzhu-100g-chk" class="lavka-kbzhu-setting-checkbox" style="display: inline-block !important; position: static !important; opacity: 1 !important; visibility: visible !important; width: 16px !important; height: 16px !important; min-width: 16px !important; min-height: 16px !important; max-width: 16px !important; max-height: 16px !important; margin: 0 8px 0 0 !important; padding: 0 !important; border: 1px solid #ccc !important; clip: auto !important; -webkit-clip-path: none !important; clip-path: none !important; overflow: visible !important; transform: none !important; pointer-events: auto !important; appearance: checkbox !important; -webkit-appearance: checkbox !important; -moz-appearance: checkbox !important; accent-color: #fce000 !important; cursor: pointer !important;" ${settings.showPer100g ? 'checked' : ''} /> Показывать на 100 г</label>
      </div>
      <div class="lavka-kbzhu-setting-row">
        <label for="kbzhu-portion-chk" style="display: flex !important; align-items: center !important; gap: 8px !important; cursor: pointer !important; font-size: 13px !important; position: relative !important; left: auto !important; top: auto !important; opacity: 1 !important; visibility: visible !important; height: auto !important; width: auto !important; box-sizing: border-box !important; margin: 0 !important; padding: 0 !important;"><input type="checkbox" id="kbzhu-portion-chk" class="lavka-kbzhu-setting-checkbox" style="display: inline-block !important; position: static !important; opacity: 1 !important; visibility: visible !important; width: 16px !important; height: 16px !important; min-width: 16px !important; min-height: 16px !important; max-width: 16px !important; max-height: 16px !important; margin: 0 8px 0 0 !important; padding: 0 !important; border: 1px solid #ccc !important; clip: auto !important; -webkit-clip-path: none !important; clip-path: none !important; overflow: visible !important; transform: none !important; pointer-events: auto !important; appearance: checkbox !important; -webkit-appearance: checkbox !important; -moz-appearance: checkbox !important; accent-color: #fce000 !important; cursor: pointer !important;" ${settings.showPerPortion ? 'checked' : ''} /> Показывать на порцию</label>
      </div>
      <div class="lavka-kbzhu-info-text">
        Загружено товаров в кэш: <span id="kbzhu-cache-count">${cacheCount}</span>
      </div>
      <div class="lavka-kbzhu-settings-footer">
        <button class="lavka-kbzhu-btn lavka-kbzhu-btn-secondary" id="kbzhu-clear-btn" title="Очистить локальный кэш товаров">Сбросить кэш</button>
        <button class="lavka-kbzhu-btn lavka-kbzhu-btn-primary" id="kbzhu-save-btn">Сохранить</button>
      </div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // События
    btn.addEventListener('click', () => {
      panel.classList.toggle('active');
      document.getElementById('kbzhu-cache-count').textContent = getCacheCount();
    });

    panel.querySelector('.lavka-kbzhu-settings-close').addEventListener('click', () => {
      panel.classList.remove('active');
    });

    document.getElementById('kbzhu-clear-btn').addEventListener('click', () => {
      if (confirm('Вы действительно хотите очистить кэш КБЖУ?')) {
        clearCache();
        document.getElementById('kbzhu-cache-count').textContent = '0';
        alert('Кэш очищен! Перезагрузите страницу для обновления.');
        
        // Сбрасываем статус обработки на карточках в DOM
        document.querySelectorAll('[data-kbzhu-status]').forEach(card => {
          card.removeAttribute('data-kbzhu-status');
          const box = card.querySelector('.lavka-kbzhu-box');
          if (box) box.remove();
        });
        scanForCards();
      }
    });

    document.getElementById('kbzhu-save-btn').addEventListener('click', () => {
      const newSettings = {
        enabled: document.getElementById('kbzhu-enabled-chk').checked,
        requestDelayMs: parseInt(document.getElementById('kbzhu-delay-input').value) || 1000,
        cacheExpirationDays: parseInt(document.getElementById('kbzhu-cache-input').value) || 7,
        showPer100g: document.getElementById('kbzhu-100g-chk').checked,
        showPerPortion: document.getElementById('kbzhu-portion-chk').checked
      };
      saveSettings(newSettings);
      panel.classList.remove('active');

      if (!newSettings.enabled) {
        removeKbzhuFromCards();
        return;
      }

      // Принудительно перерисовываем все карточки в DOM
      const cache = getCache();
      document.querySelectorAll('[data-testid="product-card"], div[class*="ProductSnippet__"]').forEach(card => {
        const link = card.querySelector('a[data-type="product-card-link"]') || card.querySelector('a[href*="/good/"]');
        if (link) {
          const slug = getSlugFromUrl(link.href);
          if (slug && cache[slug]) {
            renderKbzhu(card, cache[slug]);
          } else if (slug) {
            // Если КБЖУ нет в кэше, сбрасываем статус, чтобы скрипт перезапросил данные при необходимости
            card.removeAttribute('data-kbzhu-status');
            const box = card.querySelector('.lavka-kbzhu-box');
            if (box) box.remove();
          }
        }
      });
      scanForCards();
    });
  }

  // --- Инициализация скрипта ---
  function init() {
    if (!document.body) {
      setTimeout(init, 100);
      return;
    }

    console.log('[KbzhuScript] Инициализация скрипта...');
    
    // Внедряем CSS стили и строим меню настроек
    injectStyles();
    createSettingsUI();

    // Первичное сканирование карточек на странице
    scanForCards();

    // Отслеживание динамической подгрузки товаров (infinite scroll) и реактивного перерисовывания React-приложения
    const mutationObserver = new MutationObserver((mutations) => {
      // Если React стер настройки из DOM, восстанавливаем их
      if (!document.querySelector('.lavka-kbzhu-settings-btn')) {
        createSettingsUI();
      }

      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        scanForCards();
      }
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Запуск при готовности DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
