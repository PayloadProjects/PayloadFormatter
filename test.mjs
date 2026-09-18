import assert from 'node:assert/strict';
import { detectPayloadMode } from './payload-detection.js';
import { formatJsonBestEffort, formatXmlBestEffort } from './resilient-format.js';

assert.equal(detectPayloadMode('{"a":1}').mode, 'json');
assert.equal(detectPayloadMode('<root><a>1</a></root>').mode, 'xml');
assert.equal(detectPayloadMode('ordinary text').mode, null);

const json = formatJsonBestEffort('{"a":1,"nested":{"b":2}}');
assert.equal(json.mode, 'json');
assert.equal(json.valid, true);
assert.match(json.formatted, /\n  "a": 1,/);

const escapedJson = formatJsonBestEffort(String.raw`{\"orders\":[{\"id\":1,\"name\":\"A\"}]}`);
assert.equal(escapedJson.valid, true);
assert.match(escapedJson.formatted, /"orders": \[/);

const transported = formatJsonBestEffort(String.raw`{\"orders\":[{\"description\":\"Earn MQD\\'s\",\"brand\":\"Delta One\\&#174; Classic\",\"screen\":\"Seatback Screen Size - 18\\\\\\\" FC\"}]}`);
assert.equal(transported.valid, true);
assert.equal(transported.parsed.orders[0].description, "Earn MQD's");
assert.equal(transported.parsed.orders[0].brand, 'Delta One&#174; Classic');
assert.equal(transported.parsed.orders[0].screen, 'Seatback Screen Size - 18" FC');

const doubleEncoded = formatJsonBestEffort(JSON.stringify('{"a":1,"nested":{"b":2}}'));
assert.equal(doubleEncoded.valid, true);
assert.match(doubleEncoded.formatted, /"nested": \{/);

const trailingComma = formatJsonBestEffort('{"a":1,"nested":{"b":2,},}');
assert.equal(trailingComma.valid, true);
assert.match(trailingComma.formatted, /"b": 2/);

const brokenJson = formatJsonBestEffort('{"orders":[{"id":1},{"id":2],"tail":true}');
assert.equal(brokenJson.valid, false);
assert.equal(brokenJson.bestEffort, true);
assert.ok(brokenJson.formatted.split('\n').length >= 4);

const xml = formatXmlBestEffort('<root><item id="1">A</item><item id="2">B</item></root>');
assert.equal(xml.mode, 'xml');
assert.equal(xml.valid, true);
assert.ok(xml.formatted.includes('\n'));

const escapedXml = formatXmlBestEffort('<root name=\\\"Sai\\\"><id>123</id></root>');
assert.equal(escapedXml.valid, true);
assert.match(escapedXml.formatted, /name="Sai"/);

const wrappedXml = formatXmlBestEffort(JSON.stringify('<root><message>Earn MQD\\\'s</message></root>'));
assert.equal(wrappedXml.valid, true);
assert.match(wrappedXml.formatted, /Earn MQD's/);
assert.match(wrappedXml.formatted, /<message>/);

const brokenXml = formatXmlBestEffort('<root><customer><id>123</id></root>');
assert.equal(brokenXml.valid, false);
assert.equal(brokenXml.bestEffort, true);
assert.ok(brokenXml.formatted.includes('\n'));

console.log('All Payload Formatter JSON/XML tests passed.');
