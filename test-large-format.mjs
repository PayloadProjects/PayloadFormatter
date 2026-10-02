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

const wrappedTransportXml = formatXmlBestEffort(JSON.stringify('<root><message>Alpha\\\'s beta value</message></root>'));
assert.equal(wrappedTransportXml.valid, true);
assert.match(wrappedTransportXml.formatted, /Alpha's beta value/,
  'wrapped transport XML recovery must remain correct alongside the large-payload fast path');

const doubleWrappedTransportXml = formatXmlBestEffort(JSON.stringify(JSON.stringify('<root><id>123</id></root>')));
assert.equal(doubleWrappedTransportXml.valid, true);
assert.equal(doubleWrappedTransportXml.formatted, '<root>\n\t<id>123</id>\n</root>',
  'multiple XML transport wrappers must fully unwrap before formatting');

assert.ok(resilient.includes('startsLikeXmlDocument(normalized)'),
  'XML recovery must not accept quoted text merely because it contains XML markup');

for (const source of [
  String.raw`<root><message>Alpha\\'s beta value</message></root>`,
  String.raw`<root><message>Alpha\\\\'s beta value</message></root>`,
  String.raw`<root><message>Alpha\\\\\\'s beta value</message></root>`,
]) {
  const result = formatXmlBestEffort(JSON.stringify(source));
  assert.equal(result.valid, true);
  assert.match(result.formatted, /Alpha's beta value/,
    'multiple wrapped XML backslash layers must normalize in one formatting pass');
}
