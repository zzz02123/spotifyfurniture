const express = require('express');
const { Liquid } = require('liquidjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve assets directly
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Load locales: load Spanish by default with fallback to English
let translations = {};
try {
  const esPath = path.join(__dirname, 'locales/es.json');
  const enPath = path.join(__dirname, 'locales/en.default.json');
  const enTranslations = fs.existsSync(enPath) ? JSON.parse(fs.readFileSync(enPath, 'utf8')) : {};
  const esTranslations = fs.existsSync(esPath) ? JSON.parse(fs.readFileSync(esPath, 'utf8')) : {};
  translations = { ...enTranslations, ...esTranslations };
} catch (e) {
  console.warn('Could not load translations:', e.message);
}

function getTranslation(key, vars = {}) {
  if (!key || typeof key !== 'string') return '';
  const parts = key.split('.');
  let curr = translations;
  for (const part of parts) {
    if (curr && typeof curr === 'object' && part in curr) {
      curr = curr[part];
    } else {
      return key;
    }
  }
  if (typeof curr !== 'string') return key;
  let res = curr;
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      res = res.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
    }
  }
  return res;
}

// Color parser
function parseColor(hex) {
  if (!hex || typeof hex !== 'string') return hex;
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return hex;
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  return {
    red: r,
    green: g,
    blue: b,
    alpha: 1,
    rgb: `${r}, ${g}, ${b}`,
    toString: () => hex,
    valueOf: () => hex
  };
}

// Load settings from config/settings_data.json
let settingsData = {};
try {
  settingsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/settings_data.json'), 'utf8'));
} catch (e) {
  console.warn('Could not load settings_data.json', e.message);
}
const currentPreset = (settingsData.presets && settingsData.presets[settingsData.current]) || {};

// Prepare settings with color objects
const rawSettings = { ...currentPreset };
const colorSchemes = rawSettings.color_schemes || {};
const preparedSchemes = [];

for (const [id, scheme] of Object.entries(colorSchemes)) {
  const s = { ...scheme.settings };
  preparedSchemes.push({
    id,
    settings: {
      ...s,
      background: parseColor(s.background || '#FAF8F4'),
      text: parseColor(s.text || '#292824'),
      button: parseColor(s.button || '#747A54'),
      button_label: parseColor(s.button_label || '#FAF8F4'),
      secondary_button_label: parseColor(s.secondary_button_label || '#747A54'),
      shadow: parseColor(s.shadow || '#292824')
    }
  });
}
rawSettings.color_schemes = preparedSchemes;
rawSettings.type_body_font = {
  family: 'sans-serif',
  'system?': true,
  weight: '400',
  style: 'normal',
  toString: () => 'sans-serif'
};
rawSettings.type_header_font = {
  family: 'sans-serif',
  'system?': true,
  weight: '600',
  style: 'normal',
  toString: () => 'sans-serif'
};

// Initialize LiquidJS
const engine = new Liquid({
  root: [
    path.join(__dirname),
    path.join(__dirname, 'layout'),
    path.join(__dirname, 'sections'),
    path.join(__dirname, 'snippets'),
    path.join(__dirname, 'templates')
  ],
  extname: '.liquid',
  cache: false
});

// Custom tags
function ignoreBlockTag(tagName) {
  const endTagName = 'end' + tagName;
  engine.registerTag(tagName, {
    parse: function(token, remainTokens) {
      while (remainTokens.length) {
        const t = remainTokens.shift();
        if (t.name === endTagName || (t.getText && t.getText().includes(endTagName))) {
          break;
        }
      }
    },
    render: function*() {}
  });
}

function passthroughBlockTag(tagName, htmlTag) {
  engine.registerTag(tagName, {
    parse: function(token, remainTokens) {
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream
        .on('tag:end' + tagName, () => stream.stop())
        .on('template', tpl => this.templates.push(tpl))
        .on('end', () => { throw new Error('tag ' + tagName + ' not closed'); });
      stream.start();
    },
    render: function*(ctx, emitter) {
      emitter.write('<' + htmlTag + '>');
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      emitter.write('</' + htmlTag + '>');
    }
  });
}

ignoreBlockTag('schema');
ignoreBlockTag('doc');
passthroughBlockTag('style', 'style');
passthroughBlockTag('javascript', 'script');

// Paginate tag
engine.registerTag('paginate', {
  parse: function(token, remainTokens) {
    this.args = token.args;
    this.templates = [];
    const stream = this.liquid.parser.parseStream(remainTokens);
    stream
      .on('tag:endpaginate', () => stream.stop())
      .on('template', tpl => this.templates.push(tpl))
      .on('end', () => { throw new Error('tag paginate not closed'); });
    stream.start();
  },
  render: function*(ctx, emitter) {
    ctx.push({
      paginate: {
        current_page: 1,
        pages: 1,
        items: 8,
        page_size: 24,
        parts: []
      }
    });
    yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
    ctx.pop();
  }
});

// Form tag
engine.registerTag('form', {
  parse: function(token, remainTokens) {
    this.args = token.args;
    this.templates = [];
    const stream = this.liquid.parser.parseStream(remainTokens);
    stream
      .on('tag:endform', () => stream.stop())
      .on('template', tpl => this.templates.push(tpl))
      .on('end', () => { throw new Error('tag form not closed'); });
    stream.start();
  },
  render: function*(ctx, emitter) {
    emitter.write('<form method="post" action="/cart/add" class="shopify-product-form" enctype="multipart/form-data">');
    yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
    emitter.write('</form>');
  }
});

// Section tag: {% section 'name' %}
engine.registerTag('section', {
  parse: function(token) {
    this.sectionName = token.args.replace(/['"]/g, '').trim();
  },
  render: function*(ctx, emitter) {
    const sectionFile = `sections/${this.sectionName}.liquid`;
    const fullPath = path.join(__dirname, sectionFile);
    if (!fs.existsSync(fullPath)) return;

    const scope = ctx.getAll();
    const sectionSettings = (scope.section && scope.section.settings) || {};
    const sectionId = (scope.section && scope.section.id) || this.sectionName;

    ctx.push({
      section: {
        id: sectionId,
        type: this.sectionName,
        settings: sectionSettings,
        blocks: (scope.section && scope.section.blocks) || []
      }
    });
    const content = yield this.liquid.renderFile(sectionFile, ctx.getAll());
    emitter.write(content);
    ctx.pop();
  }
});

// Sections tag: {% sections 'name' %}
engine.registerTag('sections', {
  parse: function(token) {
    this.groupName = token.args.replace(/['"]/g, '').trim();
  },
  render: function*(ctx, emitter) {
    const groupFile = path.join(__dirname, `sections/${this.groupName}.json`);
    if (!fs.existsSync(groupFile)) return;

    try {
      const groupData = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
      const order = groupData.order || Object.keys(groupData.sections || {});
      for (const sectionKey of order) {
        const secDef = groupData.sections[sectionKey];
        if (!secDef) continue;
        const secFile = `sections/${secDef.type}.liquid`;
        if (!fs.existsSync(path.join(__dirname, secFile))) continue;

        const blocksArray = [];
        if (secDef.blocks) {
          const blockOrder = secDef.block_order || Object.keys(secDef.blocks);
          for (const bKey of blockOrder) {
            const b = secDef.blocks[bKey];
            if (b) blocksArray.push({ id: bKey, type: b.type, settings: b.settings || {} });
          }
        }

        ctx.push({
          section: {
            id: sectionKey,
            type: secDef.type,
            settings: secDef.settings || {},
            blocks: blocksArray
          }
        });
        const rendered = yield this.liquid.renderFile(secFile, ctx.getAll());
        emitter.write(rendered);
        ctx.pop();
      }
    } catch (e) {
      console.error(`Error rendering sections group ${this.groupName}:`, e.message);
    }
  }
});

// Custom Filters
engine.registerFilter('asset_url', v => `/assets/${v}`);
engine.registerFilter('stylesheet_tag', (v, opts) => `<link rel="stylesheet" href="${v}">`);
engine.registerFilter('script_tag', v => `<script src="${v}"></script>`);
engine.registerFilter('image_url', (img, opts) => {
  if (!img) return 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80';
  if (typeof img === 'string') return img;
  return img.src || img.url || 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80';
});
engine.registerFilter('image_tag', (img, attrs) => {
  const src = (img && (img.src || img.url)) || img || 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80';
  let attrStr = '';
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) {
      attrStr += ` ${k}="${v}"`;
    }
  }
  return `<img src="${src}" ${attrStr}/>`;
});
engine.registerFilter('t', (key, vars) => getTranslation(key, vars));
engine.registerFilter('font_face', () => '/* font face */');
engine.registerFilter('font_modify', (font, mod, val) => font);
engine.registerFilter('font_url', () => '');
engine.registerFilter('color_brightness', c => 50);
engine.registerFilter('color_lighten', (c, amt) => (typeof c === 'object' && c && c.red !== undefined ? c : parseColor(c || '#FAF8F4')));
engine.registerFilter('color_darken', (c, amt) => (typeof c === 'object' && c && c.red !== undefined ? c : parseColor(c || '#292824')));
engine.registerFilter('color_to_rgb', c => (typeof c === 'object' && c && c.rgb ? `rgb(${c.rgb})` : c || 'rgb(0,0,0)'));
engine.registerFilter('money', cents => {
  const n = (Number(cents) || 0) / 100;
  return `${n.toFixed(2).replace('.', ',')} €`;
});
engine.registerFilter('money_with_currency', cents => {
  const n = (Number(cents) || 0) / 100;
  return `${n.toFixed(2).replace('.', ',')} €`;
});
engine.registerFilter('money_without_currency', cents => {
  const n = (Number(cents) || 0) / 100;
  return `${n.toFixed(2).replace('.', ',')}`;
});
engine.registerFilter('standard_event_data', () => '{}');
engine.registerFilter('placeholder_svg_tag', (name, className) => {
  return `<svg class="${className || ''}" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="100" height="100" fill="#EDE5D9"/><path d="M20 70 L40 40 L60 65 L75 50 L90 70 Z" fill="#D2CCC1"/><circle cx="35" cy="30" r="8" fill="#D2CCC1"/></svg>`;
});
engine.registerFilter('inline_asset_content', fileName => {
  try {
    const p = path.join(__dirname, 'assets', fileName);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (e) {}
  return '';
});
engine.registerFilter('unit_price_with_measurement', () => '');
engine.registerFilter('link_to', (text, url) => `<a href="${url}">${text}</a>`);
engine.registerFilter('within', (url, col) => url);
engine.registerFilter('payment_type_svg_tag', type => `<span class="payment-icon">${type}</span>`);
engine.registerFilter('media_tag', () => '');
engine.registerFilter('external_video_url', url => url);
engine.registerFilter('external_video_tag', () => '');

// Math safe filters
engine.registerFilter('divided_by', (v, d) => (!d ? (Number(v) || 0) : Math.floor((Number(v) || 0) / Number(d))));
engine.registerFilter('ceil', v => Math.ceil(Number(v) || 0));
engine.registerFilter('floor', v => Math.floor(Number(v) || 0));
engine.registerFilter('round', (v, d = 0) => Number(Number(v || 0).toFixed(d)));
engine.registerFilter('at_least', (v, min) => Math.max(Number(v) || 0, Number(min) || 0));
engine.registerFilter('at_most', (v, max) => Math.min(Number(v) || 0, Number(max) || 0));

// Real Spanish Mediterranean Home Products Catalog
const sampleProducts = [
  {
    id: 101,
    title: 'Sofá 3 Plazas Lino Lavado Menorca',
    handle: 'sofa-3-plazas-lino-menorca',
    description: '<p>Diseñado con proporciones generosas y líneas limpias que invitan al descanso. Tapizado en 100% lino natural cultivado en Europa, prelavado para una textura suave e informal. La estructura interna de madera maciza y los cojines con núcleo de alta resiliencia aseguran una comodidad duradera.</p>',
    vendor: 'Casa Mediterránea',
    type: 'Sofás',
    price: 129000,
    compare_at_price: 149000,
    available: true,
    price_varies: false,
    compare_at_price_varies: false,
    url: '/products/sofa-3-plazas-lino-menorca',
    featured_media: {
      aspect_ratio: 1,
      preview_image: { src: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80', width: 800, height: 800 },
      src: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80',
      url: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80'
    },
    featured_image: {
      src: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80',
      alt: 'Sofá 3 Plazas Lino Lavado Menorca',
      aspect_ratio: 1
    },
    media: [
      {
        id: 1001,
        media_type: 'image',
        aspect_ratio: 1,
        src: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80',
        preview_image: { src: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80' }
      },
      {
        id: 1002,
        media_type: 'image',
        aspect_ratio: 1,
        src: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&auto=format&fit=crop&q=80',
        preview_image: { src: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&auto=format&fit=crop&q=80' }
      }
    ],
    images: [
      'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&auto=format&fit=crop&q=80'
    ],
    metafields: {
      custom: {
        material: 'Madera maciza de pino y lino 100% natural lavado desenfundable',
        width: '220 cm',
        height: '85 cm',
        depth: '100 cm',
        weight: '64 kg',
        assembly_required: 'No requiere montaje. Incluye patas atornilladas protegidas.',
        shipping_note: 'Envío especializado con subida a piso concertada y retirada de embalajes.',
        product_highlights: '<p>Totalmente desenfundable para lavado en seco o ciclo delicado. Cojines reversibles con doble capa de confort.</p>'
      },
      reviews: {
        rating: { value: { rating: 4.9, scale_max: 5 } },
        rating_count: 42
      }
    },
    options: ['Color'],
    options_with_values: [
      { name: 'Color', position: 1, values: ['Lino Arena', 'Blanco Roto', 'Terracota'], selected_value: 'Lino Arena' }
    ],
    selected_or_first_available_variant: {
      id: 10101,
      title: 'Lino Arena',
      price: 129000,
      compare_at_price: 149000,
      available: true,
      sku: 'SOFA-MENORCA-ARENA',
      quantity_rule: { min: 1, max: null, increment: 1 }
    },
    variants: [
      { id: 10101, title: 'Lino Arena', price: 129000, compare_at_price: 149000, available: true, option1: 'Lino Arena', quantity_rule: { min: 1, max: null, increment: 1 } },
      { id: 10102, title: 'Blanco Roto', price: 129000, compare_at_price: 149000, available: true, option1: 'Blanco Roto', quantity_rule: { min: 1, max: null, increment: 1 } },
      { id: 10103, title: 'Terracota', price: 129000, compare_at_price: 149000, available: true, option1: 'Terracota', quantity_rule: { min: 1, max: null, increment: 1 } }
    ]
  },
  {
    id: 102,
    title: 'Mesa de Comedor Roble Macizo Formentera',
    handle: 'mesa-comedor-roble-formentera',
    description: '<p>Pieza central tallada en madera maciza de roble europeo procedente de bosques gestionados de forma sostenible (FSC). Cantos sutilmente suavizados que destacan la veta natural con un tacto sedoso y resistente.</p>',
    vendor: 'Casa Mediterránea',
    type: 'Mesas',
    price: 85000,
    compare_at_price: 98000,
    available: true,
    price_varies: false,
    compare_at_price_varies: false,
    url: '/products/mesa-comedor-roble-formentera',
    featured_media: {
      aspect_ratio: 1,
      preview_image: { src: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80', width: 800, height: 800 },
      src: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80',
      url: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80'
    },
    featured_image: {
      src: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80',
      alt: 'Mesa de Comedor Roble Macizo Formentera',
      aspect_ratio: 1
    },
    media: [
      {
        id: 1021,
        media_type: 'image',
        aspect_ratio: 1,
        src: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80',
        preview_image: { src: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80' }
      }
    ],
    images: ['https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800&auto=format&fit=crop&q=80'],
    metafields: {
      custom: {
        material: 'Madera maciza de roble europeo certificado FSC con barniz mate al agua',
        width: '200 cm',
        height: '76 cm',
        depth: '95 cm',
        weight: '52 kg',
        assembly_required: 'Montaje sencillo de patas. Tiempo estimado: 15 minutos (herramientas incluidas).',
        shipping_note: 'Envío gratuito asegurado a Península y Baleares en 3-5 días laborables.',
        product_highlights: '<p>Tratamiento antimanchas transparente que preserva la porosidad natural de la madera sin alterar su tono cálido.</p>'
      },
      reviews: {
        rating: { value: { rating: 4.8, scale_max: 5 } },
        rating_count: 29
      }
    },
    options: ['Medida'],
    options_with_values: [
      { name: 'Medida', position: 1, values: ['200 x 95 cm', '240 x 100 cm'], selected_value: '200 x 95 cm' }
    ],
    selected_or_first_available_variant: {
      id: 10201,
      title: '200 x 95 cm',
      price: 85000,
      compare_at_price: 98000,
      available: true,
      sku: 'MESA-FORMENTERA-200',
      quantity_rule: { min: 1, max: null, increment: 1 }
    },
    variants: [
      { id: 10201, title: '200 x 95 cm', price: 85000, compare_at_price: 98000, available: true, option1: '200 x 95 cm', quantity_rule: { min: 1, max: null, increment: 1 } },
      { id: 10202, title: '240 x 100 cm', price: 105000, compare_at_price: 119000, available: true, option1: '240 x 100 cm', quantity_rule: { min: 1, max: null, increment: 1 } }
    ]
  },
  {
    id: 103,
    title: 'Aparador 3 Puertas Ratán & Madera Duna',
    handle: 'aparador-ratan-madera-duna',
    description: '<p>Equilibrio entre capacidad de almacenaje y ligereza visual. Las puertas con frontal de ratán trenzado a mano filtran la luz y ocultan discretamente vajillas, textiles y libros.</p>',
    vendor: 'Casa Mediterránea',
    type: 'Almacenaje',
    price: 68000,
    compare_at_price: null,
    available: true,
    price_varies: false,
    compare_at_price_varies: false,
    url: '/products/aparador-ratan-madera-duna',
    featured_media: {
      aspect_ratio: 1,
      preview_image: { src: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80', width: 800, height: 800 },
      src: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80',
      url: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80'
    },
    featured_image: {
      src: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80',
      alt: 'Aparador 3 Puertas Ratán & Madera Duna',
      aspect_ratio: 1
    },
    media: [
      {
        id: 1031,
        media_type: 'image',
        aspect_ratio: 1,
        src: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80',
        preview_image: { src: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80' }
      }
    ],
    images: ['https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=800&auto=format&fit=crop&q=80'],
    metafields: {
      custom: {
        material: 'Madera de mango natural y rejilla de ratán vegetal trenzada a mano',
        width: '160 cm',
        height: '78 cm',
        depth: '42 cm',
        weight: '38 kg',
        assembly_required: 'Montaje parcial de patas cilíndricas.',
        shipping_note: 'Entrega concertada a domicilio en Península y Baleares.',
        product_highlights: '<p>3 compartimentos interiores con baldas regulables y bisagras con sistema soft-close.</p>'
      },
      reviews: {
        rating: { value: { rating: 5.0, scale_max: 5 } },
        rating_count: 18
      }
    },
    options: ['Color'],
    options_with_values: [
      { name: 'Color', position: 1, values: ['Madera Natural', 'Nogal Claro'], selected_value: 'Madera Natural' }
    ],
    selected_or_first_available_variant: {
      id: 10301,
      title: 'Madera Natural',
      price: 68000,
      compare_at_price: null,
      available: true,
      sku: 'APARADOR-DUNA-NAT',
      quantity_rule: { min: 1, max: null, increment: 1 }
    },
    variants: [
      { id: 10301, title: 'Madera Natural', price: 68000, available: true, option1: 'Madera Natural', quantity_rule: { min: 1, max: null, increment: 1 } }
    ]
  },
  {
    id: 104,
    title: 'Silla de Comedor Fresno y Cuerda Calma',
    handle: 'silla-comedor-fresno-cuerda-calma',
    description: '<p>Inspirada en el diseño tradicional mediterráneo de sillería de anea, reinterpretada con perfilería esbelta de madera de fresno macizo y asiento trenzado en cuerda de papel kraft de alta tenacidad.</p>',
    vendor: 'Casa Mediterránea',
    type: 'Sillas',
    price: 17500,
    compare_at_price: 21000,
    available: true,
    price_varies: false,
    compare_at_price_varies: false,
    url: '/products/silla-comedor-fresno-cuerda-calma',
    featured_media: {
      aspect_ratio: 1,
      preview_image: { src: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80', width: 800, height: 800 },
      src: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80',
      url: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80'
    },
    featured_image: {
      src: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80',
      alt: 'Silla de Comedor Fresno y Cuerda Calma',
      aspect_ratio: 1
    },
    media: [
      {
        id: 1041,
        media_type: 'image',
        aspect_ratio: 1,
        src: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80',
        preview_image: { src: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80' }
      }
    ],
    images: ['https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80'],
    metafields: {
      custom: {
        material: 'Madera de fresno macizo torneada y asiento en cuerda vegetal tejida a mano',
        width: '52 cm',
        height: '78 cm',
        depth: '50 cm',
        weight: '5.5 kg',
        assembly_required: 'No requiere montaje. Se entrega completamente armada en taller.',
        shipping_note: 'Envío en cajas reforzadas de 2 unidades.'
      },
      reviews: {
        rating: { value: { rating: 4.7, scale_max: 5 } },
        rating_count: 34
      }
    },
    options: ['Acabado'],
    options_with_values: [
      { name: 'Acabado', position: 1, values: ['Fresno Natural', 'Fresno Negro'], selected_value: 'Fresno Natural' }
    ],
    selected_or_first_available_variant: {
      id: 10401,
      title: 'Fresno Natural',
      price: 17500,
      compare_at_price: 21000,
      available: true,
      sku: 'SILLA-CALMA-NAT',
      quantity_rule: { min: 1, max: null, increment: 1 }
    },
    variants: [
      { id: 10401, title: 'Fresno Natural', price: 17500, compare_at_price: 21000, available: true, option1: 'Fresno Natural', quantity_rule: { min: 1, max: null, increment: 1 } },
      { id: 10402, title: 'Fresno Negro', price: 17500, compare_at_price: 21000, available: true, option1: 'Fresno Negro', quantity_rule: { min: 1, max: null, increment: 1 } }
    ]
  },
  {
    id: 105,
    title: 'Tumbona de Exterior Teca Tramuntana',
    handle: 'tumbona-exterior-teca-tramuntana',
    description: '<p>Pieza imprescindible para disfrutar del clima mediterráneo en jardines, porches o terrazas. Teca maciza tratada para resistir la radiación solar y la humedad sin perder elegancia.</p>',
    vendor: 'Casa Mediterránea Exterior',
    type: 'Exterior',
    price: 49000,
    compare_at_price: 58000,
    available: true,
    price_varies: false,
    compare_at_price_varies: false,
    url: '/products/tumbona-exterior-teca-tramuntana',
    featured_media: {
      aspect_ratio: 1,
      preview_image: { src: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80', width: 800, height: 800 },
      src: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80',
      url: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80'
    },
    featured_image: {
      src: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80',
      alt: 'Tumbona de Exterior Teca Tramuntana',
      aspect_ratio: 1
    },
    media: [
      {
        id: 1051,
        media_type: 'image',
        aspect_ratio: 1,
        src: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80',
        preview_image: { src: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80' }
      }
    ],
    images: ['https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800&auto=format&fit=crop&q=80'],
    metafields: {
      custom: {
        material: 'Madera maciza de teca de grado A con aceites naturales y herrajes inoxidables',
        width: '70 cm',
        height: '35 cm',
        depth: '200 cm',
        weight: '18 kg',
        assembly_required: 'Montaje de ruedas traseras de deslizamiento.',
        shipping_note: 'Apta para exterior permanente.',
        product_highlights: '<p>Respaldo reclinable en 4 posiciones con soporte lumbar integrado.</p>'
      },
      reviews: {
        rating: { value: { rating: 4.8, scale_max: 5 } },
        rating_count: 21
      }
    },
    options: ['Color'],
    options_with_values: [
      { name: 'Color', position: 1, values: ['Teca Natural', 'Teca Envejecida'], selected_value: 'Teca Natural' }
    ],
    selected_or_first_available_variant: {
      id: 10501,
      title: 'Teca Natural',
      price: 49000,
      compare_at_price: 58000,
      available: true,
      sku: 'TUMBONA-TRAMUNTANA',
      quantity_rule: { min: 1, max: null, increment: 1 }
    },
    variants: [
      { id: 10501, title: 'Teca Natural', price: 49000, compare_at_price: 58000, available: true, option1: 'Teca Natural', quantity_rule: { min: 1, max: null, increment: 1 } }
    ]
  },
  {
    id: 106,
    title: 'Florero de Arcilla Torneada Artesanal',
    handle: 'florero-arcilla-torneada-artesanal',
    description: '<p>Objeto decorativo moldeado en torno cerámico por alfareros tradicionales. Textura porosa y acabado mate que rinde homenaje a la cerámica mediterránea.</p>',
    vendor: 'Taller Artesano',
    type: 'Decoración',
    price: 4800,
    compare_at_price: null,
    available: true,
    price_varies: false,
    compare_at_price_varies: false,
    url: '/products/florero-arcilla-torneada-artesanal',
    featured_media: {
      aspect_ratio: 1,
      preview_image: { src: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80', width: 800, height: 800 },
      src: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80',
      url: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80'
    },
    featured_image: {
      src: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80',
      alt: 'Florero de Arcilla Torneada Artesanal',
      aspect_ratio: 1
    },
    media: [
      {
        id: 1061,
        media_type: 'image',
        aspect_ratio: 1,
        src: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80',
        preview_image: { src: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80' }
      }
    ],
    images: ['https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&auto=format&fit=crop&q=80'],
    metafields: {
      custom: {
        material: 'Arcilla blanca chamotada con engobe mate artesanal',
        width: '18 cm',
        height: '26 cm',
        depth: '18 cm',
        weight: '1.4 kg'
      }
    },
    options: ['Tamaño'],
    options_with_values: [
      { name: 'Tamaño', position: 1, values: ['Mediano (26 cm)', 'Grande (34 cm)'], selected_value: 'Mediano (26 cm)' }
    ],
    selected_or_first_available_variant: {
      id: 10601,
      title: 'Mediano (26 cm)',
      price: 4800,
      compare_at_price: null,
      available: true,
      sku: 'FLORERO-ARCILLA-M',
      quantity_rule: { min: 1, max: null, increment: 1 }
    },
    variants: [
      { id: 10601, title: 'Mediano (26 cm)', price: 4800, available: true, option1: 'Mediano (26 cm)', quantity_rule: { min: 1, max: null, increment: 1 } }
    ]
  }
];

const sampleCollection = {
  id: 1,
  title: 'Colección Mediterránea',
  handle: 'all',
  description: 'Mobiliario, iluminación y textiles diseñados para crear hogares en sintonía con la naturaleza, la luz cálida y la calma.',
  all_products_count: sampleProducts.length,
  products_count: sampleProducts.length,
  products: sampleProducts,
  url: '/collections/all'
};

// In-memory cart
let cart = {
  token: 'preview_cart_es_123',
  note: '',
  attributes: {},
  original_total_price: 17500,
  total_price: 17500,
  total_discount: 0,
  total_weight: 5500,
  item_count: 1,
  items: [
    {
      id: 10401,
      key: '10401:1',
      title: 'Silla de Comedor Fresno y Cuerda Calma - Fresno Natural',
      product_title: 'Silla de Comedor Fresno y Cuerda Calma',
      variant_title: 'Fresno Natural',
      price: 17500,
      original_price: 21000,
      discounted_price: 17500,
      line_price: 17500,
      original_line_price: 21000,
      total_discount: 3500,
      quantity: 1,
      sku: 'SILLA-CALMA-NAT',
      grams: 5500,
      vendor: 'Casa Mediterránea',
      url: '/products/silla-comedor-fresno-cuerda-calma',
      product: {
        title: 'Silla de Comedor Fresno y Cuerda Calma',
        vendor: 'Casa Mediterránea',
        url: '/products/silla-comedor-fresno-cuerda-calma'
      },
      image: {
        src: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80',
        url: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80',
        aspect_ratio: 1,
        alt: 'Silla de Comedor Fresno y Cuerda Calma'
      },
      handle: 'silla-comedor-fresno-cuerda-calma',
      requires_shipping: true,
      product_type: 'Sillas',
      product_description: 'Inspirada en el diseño tradicional mediterráneo de sillería de anea.',
      variant_options: ['Fresno Natural'],
      options_with_values: [{ name: 'Acabado', value: 'Fresno Natural' }],
      featured_image: {
        url: 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?w=800&auto=format&fit=crop&q=80',
        aspect_ratio: 1,
        alt: 'Silla de Comedor Fresno y Cuerda Calma'
      }
    }
  ],
  requires_shipping: true,
  currency: 'EUR',
  items_subtotal_price: 17500,
  cart_level_discount_applications: []
};

function recalculateCart() {
  let count = 0;
  let total = 0;
  for (const item of cart.items) {
    count += item.quantity;
    item.line_price = item.price * item.quantity;
    item.original_line_price = item.price * item.quantity;
    total += item.line_price;
  }
  cart.item_count = count;
  cart.total_price = total;
  cart.original_total_price = total;
  cart.items_subtotal_price = total;
}

// Common global Liquid Context
function getGlobalContext(req = {}, overrides = {}) {
  const host = (req && req.get && req.get('host')) || (req && req.headers && req.headers.host) || '127.0.0.1:3000';
  const protocol = (req && req.protocol) || 'http';
  const reqPath = (req && req.path) || '/';
  return {
    shop: {
      name: 'Casa Mediterránea',
      description: 'Mobiliario y decoración minimalista de inspiración mediterránea',
      currency: 'EUR',
      money_format: '{{amount}} €',
      customer_accounts_enabled: false,
      shipping_policy: { body: 'Envío gratuito a Península a partir de 60€', url: '/policies/shipping' },
      url: `${protocol}://${host}`
    },
    settings: rawSettings,
    cart: cart,
    request: {
      origin: `${protocol}://${host}`,
      path: reqPath,
      page_type: overrides.page_type || 'index',
      locale: { iso_code: 'es', endonym_name: 'Español' }
    },
    routes: {
      root_url: '/',
      account_url: '/account',
      account_login_url: '/account/login',
      account_logout_url: '/account/logout',
      account_register_url: '/account/register',
      account_addresses_url: '/account/addresses',
      collections_url: '/collections',
      all_products_collection_url: '/collections/all',
      search_url: '/search',
      cart_url: '/cart',
      cart_add_url: '/cart/add.js',
      cart_change_url: '/cart/change.js',
      cart_clear_url: '/cart/clear.js',
      cart_update_url: '/cart/update.js',
      predictive_search_url: '/search/suggest'
    },
    localization: {
      available_countries: [{ iso_code: 'ES', name: 'España', currency: { iso_code: 'EUR', symbol: '€' } }],
      country: { iso_code: 'ES', name: 'España', currency: { iso_code: 'EUR', symbol: '€' } },
      available_languages: [{ iso_code: 'es', name: 'Español', endonym_name: 'Español' }],
      language: { iso_code: 'es', name: 'Español', endonym_name: 'Español' }
    },
    linklists: {
      'main-menu': {
        links: [
          { title: 'Inicio', url: '/', current: reqPath === '/', links: [] },
          { title: 'Salón', url: '/collections/all', current: false, links: [] },
          { title: 'Comedor', url: '/collections/all', current: false, links: [] },
          { title: 'Dormitorio', url: '/collections/all', current: false, links: [] },
          { title: 'Terraza & Exterior', url: '/collections/all', current: false, links: [] },
          { title: 'Catálogo Completo', url: '/collections/all', current: reqPath.startsWith('/collections'), links: [] },
          { title: 'Contacto', url: '/pages/contact', current: reqPath === '/pages/contact', links: [] }
        ]
      },
      footer: {
        links: [
          { title: 'Envíos y Plazos', url: '/pages/envios', links: [] },
          { title: 'Devoluciones y Cambios', url: '/pages/devoluciones', links: [] },
          { title: 'Guía de Cuidados de Madera', url: '/pages/cuidados', links: [] },
          { title: 'Garantía Oficial 3 Años', url: '/pages/garantia', links: [] },
          { title: 'Preguntas Frecuentes', url: '/pages/faq', links: [] }
        ]
      }
    },
    all_products: sampleProducts.reduce((acc, p) => { acc[p.handle] = p; return acc; }, {}),
    collections: {
      all: sampleCollection
    },
    canonical_url: `${protocol}://${host}${reqPath}`,
    page_title: overrides.page_title || 'Casa Mediterránea — Minimal Modern Home & Mediterranean Living',
    page_description: 'Mobiliario y decoración minimalista de inspiración mediterránea. Roble macizo, lino lavado, fibras naturales y piezas hechas para durar.',
    content_for_header: `<script>window.Shopify = window.Shopify || { theme: { name: 'Dawn — Casa Mediterránea' }, Currency: { active: 'EUR', rate: '1.0' } };</script>`,
    ...overrides
  };
}

// Render a template using layout/theme.liquid
async function renderWithTheme(req, res, { layoutContent, page_title, page_type, templateName, product }) {
  try {
    const globalCtx = getGlobalContext(req, {
      content_for_layout: layoutContent,
      page_title: page_title || 'Casa Mediterránea',
      page_type: page_type || 'index',
      product: product,
      template: { name: templateName || 'index' }
    });
    const html = await engine.renderFile('layout/theme.liquid', globalCtx);
    res.send(html);
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).send(`<h1>Theme Render Error</h1><pre>${err.stack || err.message}</pre>`);
  }
}

// Render dynamic sections defined in a JSON template
async function renderJsonTemplate(templatePath, context) {
  if (!fs.existsSync(templatePath)) return '<div>Template not found</div>';
  const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const order = tpl.order || Object.keys(tpl.sections || {});
  let out = '';
  for (const sKey of order) {
    const sDef = tpl.sections[sKey];
    if (!sDef) continue;
    const secFile = `sections/${sDef.type}.liquid`;
    if (!fs.existsSync(path.join(__dirname, secFile))) continue;

    const blocksArray = [];
    if (sDef.blocks) {
      const blockOrder = sDef.block_order || Object.keys(sDef.blocks);
      for (const bKey of blockOrder) {
        const b = sDef.blocks[bKey];
        if (b) blocksArray.push({ id: bKey, type: b.type, settings: b.settings || {} });
      }
    }

    const secContext = {
      ...context,
      section: {
        id: sKey,
        type: sDef.type,
        settings: {
          ...sDef.settings,
          collection: context.collection || sampleCollection
        },
        blocks: blocksArray
      }
    };
    out += await engine.renderFile(secFile, secContext);
  }
  return out;
}

// Cart API endpoints for Dawn's live JS interactions
app.get('/cart.js', (req, res) => {
  res.json(cart);
});

app.post('/cart/add.js', (req, res) => {
  const { id, quantity = 1 } = req.body;
  const numQty = parseInt(quantity, 10) || 1;
  const variantId = parseInt(id, 10);

  let targetProduct = null;
  let targetVariant = null;

  for (const p of sampleProducts) {
    const v = p.variants.find(v => v.id === variantId);
    if (v) {
      targetProduct = p;
      targetVariant = v;
      break;
    }
  }

  if (!targetProduct) {
    targetProduct = sampleProducts[0];
    targetVariant = targetProduct.variants[0];
  }

  const existing = cart.items.find(i => i.id === targetVariant.id);
  if (existing) {
    existing.quantity += numQty;
  } else {
    cart.items.push({
      id: targetVariant.id,
      key: `${targetVariant.id}:${cart.items.length + 1}`,
      title: `${targetProduct.title} - ${targetVariant.title}`,
      product_title: targetProduct.title,
      variant_title: targetVariant.title,
      price: targetVariant.price,
      original_price: targetVariant.compare_at_price || targetVariant.price,
      discounted_price: targetVariant.price,
      line_price: targetVariant.price * numQty,
      original_line_price: targetVariant.price * numQty,
      total_discount: 0,
      quantity: numQty,
      sku: targetVariant.sku || '',
      grams: 5000,
      vendor: targetProduct.vendor,
      url: targetProduct.url,
      product: {
        title: targetProduct.title,
        vendor: targetProduct.vendor,
        url: targetProduct.url
      },
      image: {
        src: targetProduct.featured_image.src,
        url: targetProduct.featured_image.src,
        aspect_ratio: 1,
        alt: targetProduct.featured_image.alt
      },
      handle: targetProduct.handle,
      requires_shipping: true,
      product_type: targetProduct.type,
      product_description: targetProduct.description,
      variant_options: [targetVariant.title],
      options_with_values: [{ name: 'Opción', value: targetVariant.title }],
      featured_image: targetProduct.featured_image
    });
  }
  recalculateCart();
  res.json(cart.items[cart.items.length - 1]);
});

app.post('/cart/change.js', (req, res) => {
  const { id, quantity } = req.body;
  const numQty = parseInt(quantity, 10);
  const itemIndex = cart.items.findIndex(i => i.id === parseInt(id, 10) || i.key === id);

  if (itemIndex > -1) {
    if (numQty <= 0) {
      cart.items.splice(itemIndex, 1);
    } else {
      cart.items[itemIndex].quantity = numQty;
    }
  }
  recalculateCart();
  res.json(cart);
});

app.post('/cart/update.js', (req, res) => {
  recalculateCart();
  res.json(cart);
});

app.post('/cart/clear.js', (req, res) => {
  cart.items = [];
  recalculateCart();
  res.json(cart);
});

// Predictive search endpoint
app.get('/search/suggest', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const matched = sampleProducts.filter(p =>
    p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q)
  );
  res.json({
    resources: {
      results: {
        products: matched.map(p => ({
          id: p.id,
          title: p.title,
          url: p.url,
          image: p.featured_image.src,
          price: `${(p.price / 100).toFixed(2).replace('.', ',')} €`,
          vendor: p.vendor
        }))
      }
    }
  });
});

// Main Page Routes
app.get('/', async (req, res) => {
  try {
    const ctx = getGlobalContext(req, {
      page_type: 'index',
      collection: sampleCollection
    });
    const layout = await renderJsonTemplate(path.join(__dirname, 'templates/index.json'), ctx);
    await renderWithTheme(req, res, {
      layoutContent: layout,
      page_title: 'Casa Mediterránea — Minimal Modern Home & Mediterranean Living',
      page_type: 'index',
      templateName: 'index'
    });
  } catch (e) {
    console.error('Route error /:', e);
    res.status(500).send(`Server error: ${e.message}`);
  }
});

const handleCollection = async (req, res) => {
  try {
    const ctx = getGlobalContext(req, {
      page_type: 'collection',
      collection: sampleCollection
    });
    const layout = await renderJsonTemplate(path.join(__dirname, 'templates/collection.json'), ctx);
    await renderWithTheme(req, res, {
      layoutContent: layout,
      page_title: 'Mobiliario & Decoración Mediterránea — Casa Mediterránea',
      page_type: 'collection',
      templateName: 'collection'
    });
  } catch (e) {
    console.error('Route error /collections:', e);
    res.status(500).send(`Server error: ${e.message}`);
  }
};
app.get('/collections', handleCollection);
app.get('/collections/:handle', handleCollection);

app.get('/products/:handle', async (req, res) => {
  try {
    const handle = req.params.handle;
    const product = sampleProducts.find(p => p.handle === handle) || sampleProducts[0];
    const ctx = getGlobalContext(req, {
      page_type: 'product',
      product: product
    });
    const layout = await renderJsonTemplate(path.join(__dirname, 'templates/product.json'), ctx);
    await renderWithTheme(req, res, {
      layoutContent: layout,
      page_title: `${product.title} — Casa Mediterránea`,
      page_type: 'product',
      templateName: 'product',
      product: product
    });
  } catch (e) {
    console.error('Route error /products:', e);
    res.status(500).send(`Server error: ${e.message}`);
  }
});

app.get('/cart', async (req, res) => {
  try {
    const ctx = getGlobalContext(req, {
      page_type: 'cart'
    });
    const layout = await renderJsonTemplate(path.join(__dirname, 'templates/cart.json'), ctx);
    await renderWithTheme(req, res, {
      layoutContent: layout,
      page_title: 'Cesta de Compra — Casa Mediterránea',
      page_type: 'cart',
      templateName: 'cart'
    });
  } catch (e) {
    console.error('Route error /cart:', e);
    res.status(500).send(`Server error: ${e.message}`);
  }
});

app.get('/pages/contact', async (req, res) => {
  try {
    const ctx = getGlobalContext(req, {
      page_type: 'page'
    });
    const layout = await renderJsonTemplate(path.join(__dirname, 'templates/page.contact.json'), ctx);
    await renderWithTheme(req, res, {
      layoutContent: layout,
      page_title: 'Contacto & Asesoramiento — Casa Mediterránea',
      page_type: 'page',
      templateName: 'page'
    });
  } catch (e) {
    console.error('Route error /pages/contact:', e);
    res.status(500).send(`Server error: ${e.message}`);
  }
});

// Fallback 404
app.use(async (req, res) => {
  try {
    const ctx = getGlobalContext(req, { page_type: '404' });
    const layout = await renderJsonTemplate(path.join(__dirname, 'templates/404.json'), ctx);
    res.status(404);
    await renderWithTheme(req, res, {
      layoutContent: layout,
      page_title: 'Página no encontrada — Casa Mediterránea',
      page_type: '404',
      templateName: '404'
    });
  } catch (e) {
    console.error('Route error 404:', e);
    res.status(404).send('Not Found');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Casa Mediterránea dev server running at http://0.0.0.0:${PORT}`);
});
