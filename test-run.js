const fs = require('fs');
const path = require('path');

// Let's test by making an actual request to server.js running inside this process
// We will assign server.js to export app if possible or we can read server.js
let code = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// Replace app.listen
const listenIdx = code.indexOf('app.listen(PORT');
if (listenIdx !== -1) {
  code = code.substring(0, listenIdx);
}

// Append our diagnostic harness
code += `
async function runDiagnostic() {
  console.log('--- STARTING DIRECT SERVER.JS TEST ---');
  const req = {
    get: (h) => '127.0.0.1:3000',
    protocol: 'http',
    path: '/',
    query: {},
    params: {},
    headers: { host: '127.0.0.1:3000' }
  };
  const res = {
    send: (html) => {
      console.log('✅ res.send CALLED! Total length:', html.length);
      console.log('Has Announcement:', html.includes('Envío peninsular'));
      console.log('Has Bestsellers:', html.includes('Los Más Vendidos'));
      console.log('Has Shop by Room:', html.includes('Comprar por Estancia'));
      process.exit(0);
    },
    status: (code) => {
      console.log('res.status:', code);
      return res;
    }
  };

  try {
    console.time('direct_route');
    const ctx = getGlobalContext(req, {
      page_type: 'index',
      collection: sampleCollection
    });
    console.log('Rendering index.json...');
    const t0 = Date.now();
    const layout = await renderJsonTemplate(path.join(__dirname, 'templates/index.json'), ctx);
    console.log('Layout done in', Date.now() - t0, 'ms. Len:', layout.length);

    console.log('Rendering with theme...');
    const t1 = Date.now();
    await renderWithTheme(req, res, {
      layoutContent: layout,
      page_title: 'Casa Mediterránea',
      page_type: 'index',
      templateName: 'index'
    });
    console.log('Theme done in', Date.now() - t1, 'ms');
  } catch(e) {
    console.error('DIAGNOSTIC ERROR:', e);
    process.exit(1);
  }
}
runDiagnostic();
`;

fs.writeFileSync(path.join(__dirname, 'test-exec.js'), code);
console.log('test-exec.js created.');
