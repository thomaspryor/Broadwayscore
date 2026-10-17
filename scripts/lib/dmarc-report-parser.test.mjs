// scripts/lib/dmarc-report-parser.test.mjs
//
// Tests the real parser (CLAUDE.md rule 15 — require()s the functions, never
// restates the logic). The zip fixture is a REAL Google aggregate report for
// broadwayscorecard.com: the hand-rolled zip reader and XML parser exist
// precisely because there is no dependency doing this, so they are pinned
// against a byte-for-byte artifact from the wild rather than a mock.
//
// The Microsoft/Zoho shapes are built as XML strings in-test rather than
// committed as fixtures on purpose: their reports carry <envelope_to>, i.e.
// recipient domains, and this repo is public.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseXml,
  parseAggregateReport,
  unpackReport,
  recordPasses,
  decodeEntities,
} = require('./dmarc-report-parser.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'dmarc-google-sample.zip');

test('parseXml: nested elements collapse leaves to text', () => {
  const doc = parseXml('<a><b>hello</b><c><d>1</d></c></a>');
  assert.equal(doc.a.b, 'hello');
  assert.equal(doc.a.c.d, '1');
});

test('parseXml: repeated siblings become an array, single ones do not', () => {
  const doc = parseXml('<r><x>1</x><x>2</x><x>3</x><y>only</y></r>');
  assert.deepEqual(doc.r.x, ['1', '2', '3']);
  assert.equal(doc.r.y, 'only');
});

test('parseXml: repeated object children keep their own fields', () => {
  const doc = parseXml('<r><rec><ip>a</ip></rec><rec><ip>b</ip></rec></r>');
  assert.equal(doc.r.rec.length, 2);
  assert.equal(doc.r.rec[0].ip, 'a');
  assert.equal(doc.r.rec[1].ip, 'b');
});

test('parseXml: strips prolog, comments and doctype', () => {
  const doc = parseXml('<?xml version="1.0"?><!-- note --><!DOCTYPE feedback><a><b>v</b></a>');
  assert.equal(doc.a.b, 'v');
});

test('parseXml: self-closing tags yield empty string, not a crash', () => {
  const doc = parseXml('<a><b/><c>x</c></a>');
  assert.equal(doc.a.b, '');
  assert.equal(doc.a.c, 'x');
});

test('parseXml: rejects malformed input rather than returning junk', () => {
  assert.throws(() => parseXml('<a><b></a>'), /mismatched tag/);
  assert.throws(() => parseXml('<a><b>'), /unclosed tag/);
  assert.throws(() => parseXml(Buffer.from('<a/>')), /expects a string/);
});

test('decodeEntities: named and numeric references', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&lt;x&gt;'), '<x>');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  // Unknown entities are left alone rather than silently deleted.
  assert.equal(decodeEntities('&nosuch;'), '&nosuch;');
});

test('unpackReport: reads the real Google zip fixture', () => {
  const xml = unpackReport(fs.readFileSync(FIXTURE));
  assert.match(xml, /<feedback>/);
  assert.match(xml, /broadwayscorecard\.com/);
});

test('unpackReport: dispatches on magic bytes, not filename', () => {
  const xml = '<feedback><version>1.0</version></feedback>';
  assert.equal(unpackReport(zlib.gzipSync(Buffer.from(xml))), xml);
  assert.equal(unpackReport(Buffer.from(xml)), xml);
  assert.throws(() => unpackReport(Buffer.from('ab')), /too short/);
  assert.throws(() => unpackReport('not a buffer'), /expects a Buffer/);
});

test('unpackReport: a PK-prefixed buffer that is not a zip fails loudly', () => {
  assert.throws(() => unpackReport(Buffer.from('PK\x03\x04 garbage padding here')), /end-of-central-directory/);
});

test('parseAggregateReport: full field extraction from the real Google report', () => {
  const report = parseAggregateReport(unpackReport(fs.readFileSync(FIXTURE)));

  assert.equal(report.orgName, 'google.com');
  assert.equal(report.orgEmail, 'noreply-dmarc-support@google.com');
  assert.equal(report.reportId, '1959646184642283739');
  assert.equal(report.dateBegin, '2026-08-29T00:00:00.000Z');
  assert.equal(report.dateEnd, '2026-08-29T23:59:59.000Z');

  assert.equal(report.policy.domain, 'broadwayscorecard.com');
  assert.equal(report.policy.p, 'quarantine');
  assert.equal(report.policy.sp, 'quarantine');
  assert.equal(report.policy.pct, 100);
  assert.equal(report.policy.adkim, 'r');
  assert.equal(report.policy.aspf, 'r');

  assert.equal(report.records.length, 10);
  assert.equal(report.messageCount, report.records.reduce((n, r) => n + r.count, 0));

  const first = report.records[0];
  assert.equal(first.sourceIp, '54.240.11.27');
  assert.equal(first.count, 1);
  assert.equal(first.disposition, 'none');
  assert.equal(first.evaluatedDkim, 'pass');
  assert.equal(first.evaluatedSpf, 'pass');
  assert.equal(first.headerFrom, 'broadwayscorecard.com');
  // Two DKIM signatures on every Resend message: our domain plus SES's.
  assert.deepEqual(first.dkim.map((d) => d.domain).sort(), ['amazonses.com', 'broadwayscorecard.com']);
  assert.equal(first.dkim.find((d) => d.domain === 'broadwayscorecard.com').selector, 'resend');
  assert.equal(first.spf[0].domain, 'send.broadwayscorecard.com');
  assert.equal(first.spf[0].result, 'pass');
});

test('parseAggregateReport: single-record report does not collapse to a non-array', () => {
  const xml = `<feedback>
    <report_metadata><org_name>solo.example</org_name><report_id>7</report_id>
      <date_range><begin>1787961600</begin><end>1788047999</end></date_range></report_metadata>
    <policy_published><domain>broadwayscorecard.com</domain><p>quarantine</p></policy_published>
    <record><row><source_ip>1.2.3.4</source_ip><count>9</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row>
      <identifiers><header_from>broadwayscorecard.com</header_from></identifiers>
      <auth_results><dkim><domain>broadwayscorecard.com</domain><result>pass</result><selector>resend</selector></dkim></auth_results>
    </record></feedback>`;
  const r = parseAggregateReport(xml);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].count, 9);
  assert.equal(r.messageCount, 9);
  // pct absent must default to 100, not NaN — a NaN here would poison every
  // downstream percentage.
  assert.equal(r.policy.pct, 100);
  assert.equal(r.policy.adkim, 'r');
});

test('parseAggregateReport: Microsoft shape with envelope_to and no DKIM selector', () => {
  const xml = `<feedback>
    <report_metadata><org_name>Outlook.com</org_name><report_id>abc123</report_id>
      <date_range><begin>1787961600</begin><end>1788047999</end></date_range></report_metadata>
    <policy_published><domain>broadwayscorecard.com</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><pct>100</pct></policy_published>
    <record><row><source_ip>54.240.9.36</source_ip><count>4</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
      <identifiers><envelope_to>Hotmail.com</envelope_to><header_from>BroadwayScorecard.com</header_from></identifiers>
      <auth_results>
        <dkim><domain>broadwayscorecard.com</domain><result>pass</result></dkim>
        <spf><domain>send.broadwayscorecard.com</domain><result>pass</result><scope>mfrom</scope></spf>
      </auth_results></record></feedback>`;
  const r = parseAggregateReport(xml);
  const rec = r.records[0];
  // Domains are lowercased so grouping never splits on reporter casing.
  assert.equal(rec.headerFrom, 'broadwayscorecard.com');
  assert.equal(rec.envelopeTo, 'hotmail.com');
  assert.equal(rec.dkim[0].selector, '');
  assert.equal(rec.spf[0].scope, 'mfrom');
});

test('parseAggregateReport: policy override reasons are captured', () => {
  const xml = `<feedback>
    <report_metadata><org_name>x</org_name><report_id>1</report_id>
      <date_range><begin>1787961600</begin><end>1788047999</end></date_range></report_metadata>
    <policy_published><domain>d.com</domain><p>reject</p></policy_published>
    <record><row><source_ip>9.9.9.9</source_ip><count>2</count>
      <policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf>
        <reason><type>forwarded</type><comment>via list</comment></reason>
      </policy_evaluated></row>
      <identifiers><header_from>d.com</header_from></identifiers>
      <auth_results></auth_results></record></feedback>`;
  const r = parseAggregateReport(xml);
  assert.deepEqual(r.records[0].overrides, ['forwarded']);
  assert.deepEqual(r.records[0].dkim, []);
});

test('parseAggregateReport: rejects XML that is not a DMARC report', () => {
  assert.throws(() => parseAggregateReport('<html><body>404</body></html>'), /missing <feedback> root/);
});

test('parseAggregateReport: a zero/garbage count never becomes NaN', () => {
  const xml = `<feedback><report_metadata><org_name>x</org_name><report_id>1</report_id>
      <date_range><begin>0</begin><end>0</end></date_range></report_metadata>
    <policy_published><domain>d.com</domain><p>none</p></policy_published>
    <record><row><source_ip>1.1.1.1</source_ip><count>notanumber</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
      <identifiers><header_from>d.com</header_from></identifiers><auth_results></auth_results></record></feedback>`;
  const r = parseAggregateReport(xml);
  assert.equal(r.records[0].count, 0);
  assert.equal(r.messageCount, 0);
  assert.equal(r.dateBegin, null, 'a zero epoch is not a real date');
});

test('recordPasses: DMARC passes on either aligned identifier', () => {
  assert.equal(recordPasses({ evaluatedDkim: 'pass', evaluatedSpf: 'fail' }), true);
  assert.equal(recordPasses({ evaluatedDkim: 'fail', evaluatedSpf: 'pass' }), true);
  assert.equal(recordPasses({ evaluatedDkim: 'pass', evaluatedSpf: 'pass' }), true);
  assert.equal(recordPasses({ evaluatedDkim: 'fail', evaluatedSpf: 'fail' }), false);
  assert.equal(recordPasses({ evaluatedDkim: '', evaluatedSpf: '' }), false);
});
