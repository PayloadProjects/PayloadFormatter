import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatJsonBestEffort, formatXmlBestEffort } from './resilient-format.js';

const [resilient, xmlSource, benchmark] = await Promise.all([
  readFile(new URL('./resilient-format.js', import.meta.url), 'utf8'),
  readFile(new URL('./xml-format.js', import.meta.url), 'utf8'),
  readFile(new URL('./benchmark.mjs', import.meta.url), 'utf8'),
]);

assert.ok(resilient.includes('LARGE_RESULT_METRICS_CHARS = 2 * 1024 * 1024'),
  'large formatted results must skip expensive exact metadata scans');
assert.ok(resilient.includes('...resultMetrics(formatted)'),
  'JSON and XML result paths should share lightweight large-result metrics');
assert.ok(!resilient.includes("original[0] === '<' && !original.includes"),
  'raw XML must not scan the whole document for escaped quotes before formatting');
assert.ok(xmlSource.includes('buffer.length >= 4096'),
  'streaming XML formatter should batch small output pieces to cap temporary-array pressure');
assert.ok(benchmark.includes('[5, 10, 20]'),
  'benchmark suite must exercise 10 MB and 20 MB JSON/XML payloads');

const jsonSample = '{"items":[' + Array(5000).fill('{"id":1,"name":"A"}').join(',') + ']}';
const xmlSample = '<root>' + '<item id="1"><name>A</name></item>'.repeat(5000) + '</root>';

const json = formatJsonBestEffort(jsonSample);
const xml = formatXmlBestEffort(xmlSample);
assert.equal(json.valid, true);
assert.equal(xml.valid, true);
assert.match(json.formatted, /"items": \[/);
assert.match(xml.formatted, /<item id="1">/);

console.log('All large-format optimization regression tests passed.');

const escapedXml = formatXmlBestEffort('<root name=\\\"Example\\\"><id>123</id></root>');
assert.equal(escapedXml.valid, true);
assert.match(escapedXml.formatted, /name="Example"/,
  'escaped XML attribute quotes must still normalize on the large-payload fast path');

assert.ok(xmlSource.includes('hasEscapedQuotes'),
  'XML tag-level fast path should detect escaped quotes without a whole-document pre-scan');
