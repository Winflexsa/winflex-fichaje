#!/usr/bin/env node
/**
 * scrape-escala.js
 * Baja la escala salarial publicada por UOYEP (CCT 797/22) y genera escala.json
 * con la misma estructura que ESCALA_CAIP en horas.html.
 *
 * Fuente: https://www.uoyepweb.org.ar/escala-salarial/
 *
 * Robusto a propósito:
 *  - No asume qué meses están publicados: los detecta de los encabezados.
 *  - No depende de thead/tbody: recorre todas las filas de todas las tablas.
 *  - Identifica filas por el nombre de categoría (primera celda).
 *  - Si el parsing falla o no encuentra datos, NO pisa el archivo: sale con error
 *    y el workflow no commitea, así la app se queda con lo último válido.
 */
 
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
 
const URL = 'https://www.uoyepweb.org.ar/escala-salarial/';
const OUT = path.join(__dirname, '..', 'escala.json');
 
const MESES_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
  // 02-10-2026: abreviaturas ("Sep 26", "Sept-26", "Set. 2026", "Feb/27")
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8,
  sep: 9, sept: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

// 02-10-2026: correcciones fijas de la suma no remunerativa.
// Ago-26: UOYEP la consolidó en el básico (suma = 0). El scraper viejo replicaba la del mes
// anterior ($85.000) cuando la columna venía vacía y por eso la app pagó $85.000 de más en agosto.
const SUMA_FIJA_CORRECCIONES = { '2026-08': 0 };
 
// Categorías por hora que la app usa en `jornal` (producción + mantenimiento).
const CATS_HORA = new Set([
  'OPERARIO', 'AUXILIAR', 'OPERADOR', 'OPERADOR CALIFICADO',
  'OPERADOR ESPECIALIZADO', 'OFICIAL ESPECIALIZADO',
  'MEDIO OFICIAL DE MANTENIMIENTO', 'OFICIAL DE MANTENIMIENTO',
]);
 
// Categorías administrativas (valor mensual de convenio). Se guardan aparte.
const CATS_MENSUAL = new Set([
  'NIVEL 1', 'NIVEL 2', 'NIVEL 3', 'NIVEL 4', 'NIVEL 5',
  'CAPATAZ', 'CHOFER', 'AYUDANTE DE CHOFER', 'CONDUCTOR DE AUTOELEVADOR',
]);
 
function normTxt(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
 
// "6.054,79" -> 6054.79 ; "85.000" -> 85000 ; "5756,21" -> 5756.21
function parseNum(s) {
  const t = normTxt(s).replace(/[^\d.,]/g, '');
  if (!t) return null;
  // Si tiene coma, la coma es decimal y el punto es separador de miles.
  if (t.includes(',')) {
    const limpio = t.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(limpio);
    return isNaN(n) ? null : n;
  }
  // Sin coma: el punto es separador de miles (montos enteros).
  const n = parseFloat(t.replace(/\./g, ''));
  return isNaN(n) ? null : n;
}
 
function normCategoria(c) {
  return normTxt(c).toUpperCase()
    .replace('OFICIAL MANTENIMIENTO', 'OFICIAL DE MANTENIMIENTO');
}
 
// "Marzo 26" / "Junio 26" -> "2026-06"
function parseMesHeader(txt) {
  const t = normTxt(txt).toLowerCase();
  // Nombres completos primero, después abreviaturas; separadores: espacio, ', ´, ., -, /, "de"
  const m = t.match(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|sept|ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)\.?\s*(?:de\s*)?[\s'´\-\/]*(\d{2,4})\b/);
  if (!m) return null;
  const mes = MESES_ES[m[1]];
  let anio = parseInt(m[2], 10);
  if (anio < 100) anio += 2000;
  return `${anio}-${String(mes).padStart(2, '0')}`;
}
 
async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WinflexEscalaBot/1.0; +https://winflexsa.github.io)',
      'Accept': 'text/html',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al bajar ${url}`);
  return await res.text();
}
 
function rowCells($, tr) {
  return $(tr).find('th,td').map((i, el) => normTxt($(el).text())).get();
}
 
function main(html) {
  const $ = cheerio.load(html);
 
  // 02-10-2026: se procesa TABLA POR TABLA. Cada tabla tiene sus propios encabezados de mes
  // (antes se tomaba sólo la primera fila de meses de toda la página y, si UOYEP publicaba dos
  // tramos en tablas distintas, los valores del segundo quedaban asignados a meses equivocados).
  const jornal = {};
  const mensualConvenio = {};
  const sumaNoRemMensual = {};
  const mesesTodos = [];

  const tablas = $('table').length ? $('table').toArray() : [$.root()];
  for (const tabla of tablas) {
    // 1) Meses de ESTA tabla: primera fila con >=2 encabezados de mes válidos.
    let meses = [];
    $(tabla).find('tr').each((i, tr) => {
      if (meses.length) return;
      const detectados = [];
      for (const c of rowCells($, tr)) {
        const ym = parseMesHeader(c);
        if (ym && !detectados.includes(ym)) detectados.push(ym);
      }
      if (detectados.length >= 2) meses = detectados;
    });
    if (!meses.length) continue;
    for (const ym of meses) if (!mesesTodos.includes(ym)) mesesTodos.push(ym);

    // 2) Filas de datos: [nombre, vh_mes1, sf_mes1, vh_mes2, sf_mes2, ...]
    const sumasTabla = {};
    $(tabla).find('tr').each((i, tr) => {
      const cells = rowCells($, tr);
      if (cells.length < 3) return;
      const cat = normCategoria(cells[0]);
      const esHora = CATS_HORA.has(cat);
      const esMensual = CATS_MENSUAL.has(cat);
      if (!esHora && !esMensual) return;
      const nums = cells.slice(1).map(parseNum);
      const valores = [], sumas = [];
      for (let k = 0; k < nums.length; k++) (k % 2 === 0 ? valores : sumas).push(nums[k]);
      const destino = esHora ? jornal : mensualConvenio;
      destino[cat] = destino[cat] || {};
      for (let mi = 0; mi < meses.length; mi++) {
        if (valores[mi] != null) destino[cat][meses[mi]] = valores[mi];
      }
      if (Object.keys(sumasTabla).length === 0) {
        for (let mi = 0; mi < meses.length; mi++) if (sumas[mi] != null) sumasTabla[meses[mi]] = sumas[mi];
      }
    });

    // Suma fija: si un mes viene SIN columna de suma fija es porque se consolidó en el
    // básico -> 0. (Antes se replicaba la del mes anterior: error de agosto 2026.)
    for (const ym of meses) sumaNoRemMensual[ym] = (sumasTabla[ym] != null) ? sumasTabla[ym] : 0;
  }
  if (!mesesTodos.length) throw new Error('No se detectaron meses en los encabezados.');
  const meses = mesesTodos.sort();
  for (const [ym, v] of Object.entries(SUMA_FIJA_CORRECCIONES)) {
    if (ym in sumaNoRemMensual) sumaNoRemMensual[ym] = v;
  }

  // Validaciones mínimas: tienen que existir categorías clave con todos los meses.
  const obligatorias = ['OPERARIO', 'OPERADOR ESPECIALIZADO', 'OFICIAL ESPECIALIZADO'];
  for (const cat of obligatorias) {
    if (!jornal[cat]) throw new Error(`Falta la categoría ${cat} en el scrape.`);
    for (const ym of meses) {
      if (jornal[cat][ym] == null) throw new Error(`Falta ${cat} en ${ym}.`);
    }
  }
 
  return {
    _meta: {
      fuente: URL,
      cct: '797/22',
      generadoEl: new Date().toISOString(),
      meses,
    },
    meses,
    sumaNoRemMensual,
    jornal,
    mensualConvenio,
  };
}
 
function mergeHistorial(data, prev) {
  const meses = new Set([...(prev.meses || []), ...data.meses]);
  data.meses = [...meses].sort();
  data._meta.meses = data.meses;
  data.sumaNoRemMensual = { ...(prev.sumaNoRemMensual || {}), ...data.sumaNoRemMensual };
  for (const [ym, v] of Object.entries(SUMA_FIJA_CORRECCIONES)) {
    if (ym in data.sumaNoRemMensual) data.sumaNoRemMensual[ym] = v;
  }
  for (const k of ['jornal', 'mensualConvenio']) {
    const out = {};
    const cats = new Set([...Object.keys(prev[k] || {}), ...Object.keys(data[k] || {})]);
    for (const c of cats) out[c] = { ...((prev[k] || {})[c] || {}), ...((data[k] || {})[c] || {}) };
    data[k] = out;
  }
  return data;
}

module.exports = { main, parseNum, parseMesHeader, normCategoria, mergeHistorial };
 
if (require.main !== module) return;
 
(async () => {
  try {
    const html = await fetchHTML(URL);
    const data = main(html);
 
    // Sólo reescribir si cambió algo relevante (evita commits vacíos por _meta).
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
    // 02-10-2026: conservar el historial. UOYEP publica sólo el tramo vigente; sin esto, al
    // salir un tramo nuevo escala.json perdía los meses anteriores (retroactivos, SAC, anclas).
    if (prev) mergeHistorial(data, prev);
    const cmp = (o) => JSON.stringify({ meses: o.meses, sumaNoRemMensual: o.sumaNoRemMensual, jornal: o.jornal, mensualConvenio: o.mensualConvenio });
    if (prev && cmp(prev) === cmp(data)) {
      console.log('Sin cambios en la escala. No se reescribe.');
      process.exit(0);
    }
 
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log('escala.json actualizado. Meses:', data.meses.join(', '));
    console.log('Categorías por hora:', Object.keys(data.jornal).length,
                '| administrativas:', Object.keys(data.mensualConvenio).length);
  } catch (e) {
    console.error('ERROR scrapeando la escala:', e.message);
    process.exit(1); // el workflow no commitea -> la app conserva lo último válido
  }
})();
