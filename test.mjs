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

const escapedJson = formatJsonBestEffort(String.raw`{\"items\":[{\"id\":1,\"name\":\"A\"}]}`);
assert.equal(escapedJson.valid, true);
assert.match(escapedJson.formatted, /"items": \[/);

const transported = formatJsonBestEffort(String.raw`{\"items\":[{\"description\":\"Alpha\\'s beta value\",\"brand\":\"Example\&#174; Value\",\"screen\":\"Value - 18\\\\\\\" Standard\"}]}`);
assert.equal(transported.valid, true);
assert.equal(transported.parsed.items[0].description, "Alpha's beta value");
assert.equal(transported.parsed.items[0].brand, 'Example&#174; Value');
assert.equal(transported.parsed.items[0].screen, 'Value - 18" Standard');

const doubleEncoded = formatJsonBestEffort(JSON.stringify('{"a":1,"nested":{"b":2}}'));
assert.equal(doubleEncoded.valid, true);
assert.match(doubleEncoded.formatted, /"nested": \{/);

const stillEscapedInner = formatJsonBestEffort(JSON.stringify(String.raw`{\\\"alpha\\\":null,\\\"items\\\":{\\\"code\\\":\\\"TEST\\\"}}`));
assert.equal(stillEscapedInner.valid, true);
assert.equal(typeof stillEscapedInner.parsed, 'object',
  'valid outer JSON strings with an escaped inner JSON nested must unwrap into an object');
assert.match(stillEscapedInner.formatted, /\n  "alpha": null,/,
  'escaped inner JSON must be structurally pretty-printed instead of left as one quoted line');

const oneClickEscaped = formatJsonBestEffort(String.raw`"{\\\"alpha\\\":null,\\\"items\\\":[{\\\"code\\\":\\\"EXAMPLE_001\\\",\\\"desc\\\":\\\"Synthetic test value\\\"}]}"`);
assert.equal(oneClickEscaped.valid, true);
assert.equal(typeof oneClickEscaped.parsed, 'object');
assert.equal(oneClickEscaped.parsed.alpha, null);
assert.match(oneClickEscaped.formatted, /^\{\n\s+"alpha": null,/,
  'escaped quoted transport JSON must fully format on the first click');

const oneClickUnescapedWrapper = formatJsonBestEffort('"{"alpha":null,"items":[{"code":"TEST"}]}"');
assert.equal(oneClickUnescapedWrapper.valid, true);
assert.equal(typeof oneClickUnescapedWrapper.parsed, 'object');
assert.match(oneClickUnescapedWrapper.formatted, /^\{\n\s+"alpha": null,/,
  'invalid literal quote wrappers must be removed and formatted in one click');

const quoteBackslashPrefix = formatJsonBestEffort(String.raw`"\\{\\\"alphaId\\\":null,\\\"nested\\\":{\\\"number\\\":123}}\\\""`);
assert.equal(quoteBackslashPrefix.valid, true);
assert.equal(typeof quoteBackslashPrefix.parsed, 'object');
assert.equal(quoteBackslashPrefix.parsed.alphaId, null);
assert.equal(quoteBackslashPrefix.parsed.nested.number, 123);
assert.match(quoteBackslashPrefix.formatted, /^\{\n/,
  'quote-plus-backslash transport prefixes before the real JSON must be removed in one click');

const arbitraryBackslashLayers = formatJsonBestEffort(String.raw`{\\\\\\\"alpha\\\\\\\":null,\\\\\\\"items\\\\\\\":[{\\\\\\\"code\\\\\\\":\\\\\\\"TEST\\\\\\\"}]}`);
assert.equal(arbitraryBackslashLayers.valid, true);
assert.equal(typeof arbitraryBackslashLayers.parsed, 'object');
assert.equal(arbitraryBackslashLayers.parsed.items[0].code, 'TEST');
assert.match(arbitraryBackslashLayers.formatted, /^\{\n/,
  'multiple escaped quote layers must recover and format in one click');

const legitimateBackslashes = formatJsonBestEffort('{"path":"C:\\\\temp\\\\file.txt","message":"line1\\nline2","quote":"say \\\"hi\\\""}');
assert.equal(legitimateBackslashes.valid, true);
assert.equal(legitimateBackslashes.parsed.path, 'C:\\temp\\file.txt');
assert.equal(legitimateBackslashes.parsed.message, 'line1\nline2');
assert.equal(legitimateBackslashes.parsed.quote, 'say "hi"',
  'valid JSON backslashes inside values must be preserved');

const oneClickIdempotent = formatJsonBestEffort(oneClickEscaped.formatted);
assert.equal(oneClickIdempotent.formatted, oneClickEscaped.formatted,
  'one-click recovered JSON must already be fully formatted; a second click must not change it');

const multiWrappedXml = formatXmlBestEffort(JSON.stringify(JSON.stringify('<root><item>A</item></root>')));
assert.equal(multiWrappedXml.valid, true);
assert.match(multiWrappedXml.formatted, /<root>/);
assert.match(multiWrappedXml.formatted, /<item>A<\/item>/,
  'multi-layer wrapped XML must also unwrap and format in one click');

const trailingComma = formatJsonBestEffort('{"a":1,"nested":{"b":2,},}');
assert.equal(trailingComma.valid, true);
assert.match(trailingComma.formatted, /"b": 2/);

const brokenJson = formatJsonBestEffort('{"items":[{"id":1},{"id":2],"tail":true}');
assert.equal(brokenJson.valid, false);
assert.equal(brokenJson.bestEffort, true);
assert.ok(brokenJson.formatted.split('\n').length >= 4);

const xml = formatXmlBestEffort('<root><item id="1">A</item><item id="2">B</item></root>');
assert.equal(xml.mode, 'xml');
assert.equal(xml.valid, true);
assert.ok(xml.formatted.includes('\n'));

const escapedXml = formatXmlBestEffort('<root name=\\\"Example\\\"><id>123</id></root>');
assert.equal(escapedXml.valid, true);
assert.match(escapedXml.formatted, /name="Example"/);

const wrappedXml = formatXmlBestEffort(JSON.stringify('<root><message>Earn SAMPLE\\\'s</message></root>'));
assert.equal(wrappedXml.valid, true);
assert.match(wrappedXml.formatted, /Alpha's beta value/);
assert.match(wrappedXml.formatted, /<message>/);

const brokenXml = formatXmlBestEffort('<root><node><id>123</id></root>');
assert.equal(brokenXml.valid, false);
assert.equal(brokenXml.bestEffort, true);
assert.ok(brokenXml.formatted.includes('\n'));

const jsonCanonicalA = formatJsonBestEffort('{\r\n  "a": 1,\r\n  "nested": { "b": 2 }\r\n}');
const jsonCanonicalB = formatJsonBestEffort('{"a":1,"nested":{"b":2}}');
assert.equal(jsonCanonicalA.formatted, jsonCanonicalB.formatted,
  'equivalent JSON formatting must normalize to one stable representation');
assert.equal(formatJsonBestEffort(jsonCanonicalA.formatted).formatted, jsonCanonicalA.formatted,
  'JSON formatting must be idempotent');

const xmlCompact = formatXmlBestEffort('<root><item id="1">A</item><item id="2">B</item></root>');
const xmlManual = formatXmlBestEffort('<root>\r\n  <item id="1">A</item>\r\n  <item id="2">B</item>\r\n</root>');
assert.equal(xmlCompact.formatted, xmlManual.formatted,
  'equivalent XML formatting must normalize to one stable representation');
assert.match(xmlCompact.formatted, /<item id="1">A<\/item>/,
  'leaf XML text must remain on the same physical line as its element');
assert.equal(formatXmlBestEffort(xmlCompact.formatted).formatted, xmlCompact.formatted,
  'XML formatting must be idempotent');

const xmlMixed = formatXmlBestEffort('<p>Hello <b>world</b>!</p>');
assert.equal(xmlMixed.formatted, '<p>Hello <b>world</b>!</p>',
  'mixed XML content must not gain formatting whitespace');
const xmlQuotedGt = formatXmlBestEffort('<root><item note="A > B">value</item></root>');
assert.match(xmlQuotedGt.formatted, /note="A > B"/,
  'greater-than characters inside XML attribute values must not break tokenization');


const nppStructure = formatXmlBestEffort('<a>\n<b/>\n\n<!--note-->\n<d/>\n</a>');
assert.equal(nppStructure.formatted, '<a>\n\t<b/>\n\t<!--note-->\n\t<d/>\n</a>',
  'XML formatting should match XML Tools structural indentation and blank-line removal');

const nppAttributes = formatXmlBestEffort('<p xmlns:x="urn:x"   a = "1"  b c=\'2\'><x/></p>');
assert.equal(nppAttributes.formatted, '<p xmlns:x="urn:x" a="1" b c=\'2\'>\n\t<x/>\n</p>',
  'XML formatting should normalize opening-tag whitespace like XML Tools');

const nppEmpty = formatXmlBestEffort('<root><empty></empty><value>1</value></root>');
assert.equal(nppEmpty.formatted, '<root>\n\t<empty/>\n\t<value>1</value>\n</root>',
  'XML formatting should autoclose directly empty element pairs like XML Tools defaults');

console.log('All Payload Formatter JSON/XML tests passed.');
