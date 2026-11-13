import { describe, expect, it } from 'vitest';
import { scanXml, xmlAttribute, type XmlElement } from './xml-scan';

function scan(xml: string | Uint8Array) {
  const starts: XmlElement[] = [];
  const ends: string[] = [];
  scanXml(typeof xml === 'string' ? new TextEncoder().encode(xml) : xml, {
    start: (element) => starts.push(element),
    end: (local, ns) => ends.push(`${ns ?? ''}|${local}`),
  }, 'test part');
  return { starts, ends };
}

describe('XML tag scanner', () => {
  it('bounds element depth before visiting a deeply nested start or empty tag', () => {
    expect(() => scan('<a>'.repeat(128) + '</a>'.repeat(128))).not.toThrow();
    for (const last of ['<a></a>', '<a/>']) {
      const start = () => scan('<a>'.repeat(128) + last + '</a>'.repeat(128));
      expect(start).toThrow(/XML element depth exceeds 128/);
    }
  });

  it('bounds in-scope namespaces even in a shallow document', () => {
    const declarations = Array.from({ length: 128 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
    expect(() => scan(`<a ${declarations}/>`)).toThrow(/XML namespace scope exceeds 128/);
  });

  it('allows namespace rebinding at the limit and restores the parent scope', () => {
    // The implicit xml prefix occupies one of the 128 scope entries.
    const declarations = Array.from({ length: 127 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
    const { starts } = scan(`<a ${declarations}><p0:b xmlns:p0="urn:shadow"/><p0:b/></a>`);
    expect(starts.map((element) => element.ns)).toEqual([undefined, 'urn:shadow', 'urn:0']);
  });

  it('does not accumulate namespaces from closed siblings', () => {
    const siblings = Array.from({ length: 256 }, (_, i) => `<b xmlns:p${i}="urn:${i}"/>`).join('');
    expect(scan(`<a>${siblings}</a>`).starts).toHaveLength(257);
  });

  it('resolves namespaces per scope and decodes attribute entities and UTF-8', () => {
    const { starts, ends } = scan('﻿<?xml version="1.0"?><!-- c --><a xmlns="urn:a" xmlns:p="urn:p" p:path="/x&amp;y" t=\'&lt;&#65;&#x42;\'>'
      + '<p:b k="ü"/><c xmlns="urn:c"><![CDATA[<d/>]]><d/></c><d/></a>');
    expect(starts.map((element) => `${element.ns}|${element.local}@${element.depth}`)).toEqual(['urn:a|a@0', 'urn:p|b@1', 'urn:c|c@1', 'urn:c|d@2', 'urn:a|d@1']);
    expect(xmlAttribute(starts[0], 'path', 'urn:p')).toBe('/x&y');
    expect(xmlAttribute(starts[0], 'path')).toBeUndefined();
    expect(xmlAttribute(starts[0], 't')).toBe('<AB');
    expect(xmlAttribute(starts[1], 'k')).toBe('ü');
    expect(ends).toEqual(['urn:p|b', 'urn:c|d', 'urn:c|c', 'urn:a|d', 'urn:a|a']);
  });

  it('rejects malformed markup, DTDs, undefined entities and UTF-16', () => {
    const cases: [string, RegExp][] = [
      ['', /no root element/],
      ['<a><b></a>', /expected <\/b> but found <\/a>/],
      ['<a x="1>', /unterminated attribute/],
      ['<a x=1/>', /not quoted/],
      ['<a/><b/>', /content after the root element/],
      ['<!DOCTYPE a><a/>', /DTD/],
      ['<a x="&bomb;"/>', /undefined entity/],
      ['<a', /unterminated start tag|expected a name/],
    ];
    for (const [xml, error] of cases) expect(() => scan(xml), xml).toThrow(error);
    expect(() => scan(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toThrow(/UTF-16/);
  });
});
