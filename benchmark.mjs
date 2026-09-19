import { performance } from 'node:perf_hooks';
import { formatJsonBestEffort, formatXmlBestEffort } from './resilient-format.js';

function makeJson(targetBytes) {
  const item = JSON.stringify({
    id: 123456,
    alphaId: null,
    code: 'EXAMPLE_001',
    message: 'Synthetic benchmark value',
    active: true,
    values: [1, 2, 3, 4, 5],
  });
  const count = Math.max(1, Math.ceil((targetBytes - 20) / (item.length + 1)));
  return '{"items":[' + Array(count).fill(item).join(',') + ']}';
}

function makeXml(targetBytes) {
  const item = '<item id="123456"><alphaId/><code>EXAMPLE_001</code><message>Synthetic benchmark value</message><active>true</active></item>';
  const count = Math.max(1, Math.ceil((targetBytes - 13) / item.length));
  return '<root>' + item.repeat(count) + '</root>';
}

function measure(label, payload, fn) {
  // Warm up the JIT on a smaller prefix before measuring the full document.
  fn(payload.slice(0, Math.min(payload.length, 32 * 1024)));
  const start = performance.now();
  const result = fn(payload);
  const elapsed = performance.now() - start;
  console.log(`${label}: input=${(payload.length / 1024 / 1024).toFixed(2)} MB output=${(result.formatted.length / 1024 / 1024).toFixed(2)} MB core=${elapsed.toFixed(1)} ms reported=${result.elapsedMs} ms`);
  return elapsed;
}

const requested = [Number(process.env.BENCH_MB || 5)];

for (const sizeMb of requested) {
  const target = sizeMb * 1024 * 1024;
  measure(`JSON ${sizeMb}MB`, makeJson(target), formatJsonBestEffort);
  measure(`XML  ${sizeMb}MB`, makeXml(target), formatXmlBestEffort);
}
