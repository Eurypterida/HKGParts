const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3000;

var rateCache = { rates: null, fetchedAt: 0 };

function getRates() {
  return new Promise(function(resolve, reject) {
    var now = Date.now();
    if (rateCache.rates && (now - rateCache.fetchedAt < 3600000)) { resolve(rateCache.rates); return; }
    https.get('https://open.er-api.com/v6/latest/KRW', { headers: { 'User-Agent': 'Mozilla/5.0' } }, function(res) {
      var body = ''; res.on('data', function(c) { body += c; }); res.on('end', function() {
        try { var d = JSON.parse(body); if (d.rates) { rateCache.rates = d.rates; rateCache.fetchedAt = now; resolve(d.rates); } else reject(new Error('No rates')); } catch (e) { reject(e); }
      }); }).on('error', reject);
  });
}

function httpGet(urlStr, headers) {
  return new Promise(function(resolve, reject) {
    var mod = urlStr.startsWith('https') ? https : http;
    mod.get(urlStr, { headers: headers || {} }, function(res) {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var redir = res.headers.location;
        if (redir.startsWith('/')) redir = new URL(redir, urlStr).href;
        httpGet(redir, headers).then(resolve).catch(reject);
        return;
      }
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
    }).on('error', reject);
  });
}

function fetchMobis(part, brand) {
  return new Promise(function(resolve, reject) {
    var u = 'https://www.mobis-as.com/simple_search_partLoad.do?pageIndex=1&hkgb=' + brand + '&vtyp=&catSeq=&srchType=ptno&inText=' + encodeURIComponent(part);
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, function(res) {
      var body = ''; res.on('data', function(c) { body += c; }); res.on('end', function() {
        if (body.indexOf('\uAC80\uC0C9\uB41C \uBD80\uD488\uC774 \uC5C6\uC2B5\uB2C8\uB2E4') !== -1) { resolve(null); return; }
        var cells = [], re = /<span class="t-td"[^>]*>([\s\S]*?)<\/span>/g, m;
        while ((m = re.exec(body)) !== null) { var t = m[1].replace(/<[^>]*>/g, '').trim(); if (t) cells.push(t); }
        var nameKr = cells[1] || '', nameEn = cells[2] || '', priceStr = cells[3] || '';
        if (!nameKr && !nameEn && !priceStr) { resolve(null); return; }
        var priceNum = parseInt(priceStr.replace(/[^0-9]/g, ''), 10) || 0;
        resolve({ partNumber: part, nameKr: nameKr, nameEn: nameEn, priceStr: priceStr, priceNum: priceNum, brand: brand });
      }); }).on('error', reject);
  });
}

function fetchFroza(part) {
  var ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  // Webshare.io proxies (shared credentials)
  var proxies = [
    { host: '31.59.20.176', port: 6754 },
    { host: '23.95.150.145', port: 6114 },
    { host: '198.23.239.134', port: 6540 },
    { host: '45.38.107.97', port: 6014 },
    { host: '107.172.163.27', port: 6543 },
    { host: '198.105.121.200', port: 6462 },
    { host: '216.10.27.159', port: 6837 },
    { host: '142.111.67.146', port: 5611 },
    { host: '191.96.254.138', port: 6185 },
    { host: '31.58.9.4', port: 6077 }
  ];
  var proxyUser = 'lqnxzqbi';
  var proxyPass = '0ahou7daw751';

  function getRandomProxy() {
    return proxies[Math.floor(Math.random() * proxies.length)];
  }

  function proxyGet(targetUrl) {
    return new Promise(function(resolve, reject) {
      var proxy = getRandomProxy();
      var target = new URL(targetUrl);
      var auth = Buffer.from(proxyUser + ':' + proxyPass).toString('base64');

      var options = {
        hostname: proxy.host,
        port: proxy.port,
        method: 'GET',
        path: targetUrl,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
          'Host': target.host,
          'Proxy-Authorization': 'Basic ' + auth
        }
      };

      var req = https.request(options, function(res) {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var redir = res.headers.location;
          if (redir.startsWith('/')) redir = target.protocol + '//' + target.host + redir;
          proxyGet(redir).then(resolve).catch(reject);
          res.resume();
          return;
        }
        var body = '';
        res.on('data', function(c) { body += c; });
        res.on('end', function() { resolve({ status: res.statusCode, body: body }); });
      });
      req.on('error', function(e) {
        reject(new Error('Proxy error: ' + e.message));
      });
      req.setTimeout(15000, function() {
        req.destroy();
        reject(new Error('Proxy timeout'));
      });
      req.end();
    });
  }

  function parseFrozaJson(jsonStr) {
    var prices = [];
    try {
      var resp = JSON.parse(jsonStr);
      if (!resp || !resp.data || typeof resp.data !== 'object') return prices;
      var cols = resp.columns || {};
      var priceIdx = cols.price_full != null ? cols.price_full : 16;
      var supplierIdx = cols.supplier_logo != null ? cols.supplier_logo : 9;
      var deliveryIdx = cols.delivery_time != null ? cols.delivery_time : 13;
      var descIdx = cols.description_rus != null ? cols.description_rus : 15;
      var brands = Object.keys(resp.data);
      for (var b = 0; b < brands.length; b++) {
        var partData = resp.data[brands[b]];
        if (!partData || typeof partData !== 'object') continue;
        var partNums = Object.keys(partData);
        for (var p = 0; p < partNums.length; p++) {
          var rows = partData[partNums[p]];
          if (!Array.isArray(rows)) continue;
          for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            if (!Array.isArray(row)) continue;
            var price = parseFloat(row[priceIdx]) || 0;
            if (price > 0) {
              prices.push({
                price: price,
                brand: String(row[supplierIdx] || ''),
                delivery: String(row[deliveryIdx] || ''),
                name: String(row[descIdx] || '')
              });
            }
          }
        }
      }
    } catch (e) {}
    return prices;
  }

  var searchUrl = 'https://www.froza.ru/search.php?multi=1&detail_num=' + encodeURIComponent(part) + '&make_name=&currency=&country=10&region_id=0&discount_id=0&sort=&add_warehouse=';

  return proxyGet(searchUrl).then(function(pageRes) {
    var codeMatch = pageRes.body.match(/data-code="([^"]+)"/);
    if (!codeMatch) {
      console.log('[Froza] No code found. Status:', pageRes.status, 'Preview:', pageRes.body.substring(0, 300));
      return { found: false, error: 'No session code', totalOffers: 0, top5: [] };
    }
    var code = codeMatch[1];
    console.log('[Froza] Got code:', code);

    var apiUrl = 'https://www.froza.ru/index.php/search/original.json?multi=1&detail_num=' + encodeURIComponent(part) + '&make_name=&currency=RUB&country=10&region_id=0&discount_id=0&sort=sortByPrice&add_warehouse=&code=' + code;
    return proxyGet(apiUrl).then(function(apiRes) {
      var prices = parseFrozaJson(apiRes.body);
      prices.sort(function(a, b) { return a.price - b.price; });
      if (prices.length > 0) {
        return { found: true, totalOffers: prices.length, top5: prices.slice(0, 5) };
      }
      return { found: false, error: 'No offers found', totalOffers: 0, top5: [] };
    });
  }).catch(function(e) {
    console.log('[Froza] Error:', e.message);
    return { found: false, error: 'Froza error: ' + e.message, totalOffers: 0, top5: [] };
  });
}

var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Parts Price Search</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem}' +
'h1{font-size:1.8rem;margin-bottom:1.5rem}' +
'.search-box{display:flex;gap:.5rem;margin-bottom:2rem;width:100%;max-width:700px}' +
'input[type=text]{flex:1;padding:.75rem 1rem;font-size:1rem;border:1px solid #334155;border-radius:8px;background:#1e293b;color:#e2e8f0;outline:none}' +
'input[type=text]:focus{border-color:#3b82f6}' +
'select{padding:.75rem;font-size:1rem;border:1px solid #334155;border-radius:8px;background:#1e293b;color:#e2e8f0}' +
'button{padding:.75rem 1.5rem;font-size:1rem;border:none;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer;font-weight:600}' +
'button:hover{background:#2563eb}' +
'button:disabled{opacity:.5;cursor:not-allowed}' +
'.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem;width:100%;max-width:700px;margin-bottom:1rem}' +
'.card-title{font-size:1.1rem;font-weight:700;margin-bottom:1rem;display:flex;align-items:center;gap:.5rem}' +
'.part-num{font-size:1.3rem;font-weight:700;color:#3b82f6;margin-bottom:.25rem}' +
'.name-kr{font-size:.95rem;color:#94a3b8}' +
'.name-en{font-size:.95rem;color:#64748b;margin-bottom:1rem}' +
'.prices{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-top:.5rem}' +
'.price-card{background:#0f172a;border-radius:10px;padding:1rem;text-align:center}' +
'.flag{font-size:1.5rem}' +
'.currency{font-size:.75rem;color:#64748b;margin-top:.25rem}' +
'.amount{font-size:1.3rem;font-weight:700;margin-top:.25rem}' +
'.brand-badge{display:inline-block;padding:.25rem .75rem;border-radius:999px;font-size:.8rem;font-weight:600;margin-bottom:1rem}' +
'.brand-badge.hyundai{background:#1d4ed8;color:#fff}' +
'.brand-badge.kia{background:#dc2626;color:#fff}' +
'.froza-table{width:100%;border-collapse:collapse;margin-top:.5rem}' +
'.froza-table th{text-align:left;padding:.5rem;color:#64748b;font-size:.8rem;border-bottom:1px solid #334155}' +
'.froza-table td{padding:.5rem;font-size:.9rem;border-bottom:1px solid #1e293b}' +
'.froza-table .price-cell{color:#22c55e;font-weight:700}' +
'.error{color:#ef4444;background:#1e293b;border:1px solid #ef4444;border-radius:12px;padding:1rem;max-width:700px;width:100%;text-align:center;margin-bottom:1rem}' +
'.loading{color:#94a3b8}' +
'.section-title{font-size:.85rem;color:#64748b;margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.05em}' +
'.offers-count{font-size:.85rem;color:#3b82f6;font-weight:600;margin-left:.5rem}' +
'.froza-brand{color:#f97316}' +
'</style></head><body>' +
'<h1>\uD83D\uDD0D Parts Price Search</h1>' +
'<div class="search-box">' +
'<input type="text" id="partNum" placeholder="Part number (e.g. 367202F000)" autofocus>' +
'<select id="brand"><option value="auto">Auto</option><option value="H">Hyundai</option><option value="K">Kia</option></select>' +
'<button onclick="doSearch()" id="btn">Search</button></div>' +
'<div id="result"></div>' +
'<script>' +
'document.getElementById("partNum").addEventListener("keydown",function(e){if(e.key==="Enter")doSearch()});' +
'function doSearch(){' +
'var p=document.getElementById("partNum").value.trim();if(!p)return;' +
'var b=document.getElementById("brand").value;var btn=document.getElementById("btn");var r=document.getElementById("result");' +
'btn.disabled=true;btn.textContent="Searching...";' +
'r.innerHTML="<p class=loading>Searching Mobis + Froza...</p>";' +
'fetch("/api/search?part="+encodeURIComponent(p)+"&brand="+b)' +
'.then(function(x){return x.json()})' +
'.then(function(d){var h="";' +
// Mobis card
'if(d.mobis&&!d.mobis.error){' +
'var bc=d.mobis.brand==="H"?"hyundai":"kia";var bn=d.mobis.brand==="H"?"Hyundai":"Kia";' +
'h+="<div class=card><div class=card-title>\uD83C\uDDF0\uD83C\uDDF7 Mobis Korea</div>"+' +
'"<span class=brand-badge "+bc+">"+bn+"</span>"+' +
'"<div class=part-num>"+d.mobis.partNumber+"</div>"+' +
'"<div class=name-kr>"+d.mobis.nameKr+"</div>"+' +
'"<div class=name-en>"+d.mobis.nameEn+"</div>"+' +
'"<div class=prices>"+' +
'"<div class=price-card><div class=flag>\uD83C\uDDF0\uD83C\uDDF7</div><div class=currency>KRW</div><div class=amount style=color:#22c55e>"+d.mobis.priceKrw+"</div></div>"+' +
'"<div class=price-card><div class=flag>\uD83C\uDDFA\uD83C\uDDF8</div><div class=currency>USD</div><div class=amount style=color:#3b82f6>$"+d.mobis.priceUsd+"</div></div>"+' +
'"<div class=price-card><div class=flag>\uD83C\uDDF7\uD83C\uDDFA</div><div class=currency>RUB</div><div class=amount style=color:#f97316>"+d.mobis.priceRub+" \u20BD</div></div>"+' +
'"</div></div>";' +
'}else if(d.mobis&&d.mobis.error){' +
'h+="<div class=error>\uD83C\uDDF0\uD83C\uDDF7 Mobis: "+d.mobis.error+"</div>";' +
'}' +
// Froza card
'if(d.froza&&d.froza.found){' +
'h+="<div class=card><div class=card-title>\uD83C\uDDF7\uD83C\uDDFA Froza.ru (wholesale)<span class=offers-count>"+d.froza.totalOffers+" offers</span></div>"+' +
'"<div class=section-title>Top 5 cheapest</div>"+' +
'"<table class=froza-table><thead><tr><th>#</th><th>Brand</th><th>Price (RUB)</th><th>Delivery</th></tr></thead><tbody>";' +
'for(var i=0;i<d.froza.top5.length;i++){var f=d.froza.top5[i];' +
'h+="<tr><td>"+(i+1)+"</td><td class=froza-brand>"+f.brand+"</td><td class=price-cell>"+f.price.toFixed(2)+" \u20BD</td><td>"+(f.delivery||"-")+"</td></tr>";' +
'}' +
'h+="</tbody></table></div>";' +
'}else if(d.froza){' +
'h+="<div class=error>\uD83C\uDDF7\uD83C\uDDFA Froza: "+(d.froza.error||"No offers found")+"</div>";' +
'}' +
'if(!h)h="<div class=error>No results from any source</div>";' +
'r.innerHTML=h;' +
'})' +
'.catch(function(){r.innerHTML="<div class=error>Connection error</div>"})' +
'.finally(function(){btn.disabled=false;btn.textContent="Search"})}' +
'</script></body></html>';

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  if (parsed.pathname === '/api/search') {
    var part = parsed.query.part, brand = parsed.query.brand || 'H';
    if (!part) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Part number required'})); return; }

    var mobisP = brand === 'auto'
      ? fetchMobis(part, 'H').then(function(r) { return r || fetchMobis(part, 'K'); })
      : fetchMobis(part, brand);
    var frozaP = fetchFroza(part);
    var ratesP = getRates().catch(function() { return null; });

    Promise.all([mobisP, frozaP, ratesP]).then(function(results) {
      var mobisData = results[0], frozaData = results[1], rates = results[2];
      var resp = { mobis: null, froza: frozaData };

      if (mobisData && rates) {
        resp.mobis = {
          partNumber: mobisData.partNumber,
          nameKr: mobisData.nameKr,
          nameEn: mobisData.nameEn,
          priceKrw: mobisData.priceStr,
          priceUsd: (mobisData.priceNum * rates.USD).toFixed(2),
          priceRub: (mobisData.priceNum * rates.RUB).toFixed(2),
          brand: mobisData.brand
        };
      } else if (mobisData) {
        resp.mobis = {
          partNumber: mobisData.partNumber,
          nameKr: mobisData.nameKr,
          nameEn: mobisData.nameEn,
          priceKrw: mobisData.priceStr,
          priceUsd: 'N/A',
          priceRub: 'N/A',
          brand: mobisData.brand
        };
      } else {
        resp.mobis = { error: 'Part not found' };
      }

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(resp));
    }).catch(function(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'Server error: ' + e.message }));
    });
  } else {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(html);
  }
});

server.listen(PORT, function() {
  console.log('Parts Price Search running at http://localhost:' + PORT);
});