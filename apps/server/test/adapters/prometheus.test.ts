import { describe, expect, it } from 'vitest';
import { MAX_LINE_LENGTH, MAX_VALUE_LENGTH, parsePrometheusText } from '../../src/adapters/prometheus.js';
import { fixture } from './helpers.js';

describe('parsePrometheusText', () => {
  it('parses samples with and without labels and skips comments', () => {
    const { samples, invalidLines } = parsePrometheusText(
      ['# HELP up Is up', '# TYPE up gauge', 'up 1', '', 'http_requests_total{method="post",code="200"} 1027 1395066363000'].join(
        '\n',
      ),
    );
    expect(invalidLines).toBe(0);
    expect(samples).toEqual([
      { name: 'up', labels: {}, value: 1 },
      { name: 'http_requests_total', labels: { method: 'post', code: '200' }, value: 1027, timestamp: 1395066363000 },
    ]);
  });

  it('unescapes label values', () => {
    const { samples } = parsePrometheusText(
      'm{a="say \\"hi\\"",b="back\\\\slash",c="multi\\nline",d="comma, and } brace"} 2',
    );
    expect(samples[0]!.labels).toEqual({ a: 'say "hi"', b: 'back\\slash', c: 'multi\nline', d: 'comma, and } brace' });
  });

  it('handles special values, exponents, whitespace and trailing commas', () => {
    const { samples } = parsePrometheusText(
      ['a +Inf', 'b -Inf', 'c NaN', 'd 1.5e3', 'e{ x = "1" , } -0.25', 'f{} 7', 'g\t3\r'].join('\n'),
    );
    expect(samples.map((s) => s.value)).toEqual([Infinity, -Infinity, NaN, 1500, -0.25, 7, 3]);
    expect(samples[4]!.labels).toEqual({ x: '1' });
  });

  it('counts malformed lines instead of throwing', () => {
    const { samples, invalidLines } = parsePrometheusText(
      ['ok 1', 'broken{a="1" 2', 'novalue', 'bad{a=1} 2', '1abc 3', 'x{a="unterminated} 1', 'y abc', 'z 1 2 3'].join(
        '\n',
      ),
    );
    expect(samples.map((s) => s.name)).toEqual(['ok']);
    expect(invalidLines).toBe(7);
  });

  it('accepts every float spelling of the exposition format', () => {
    const { samples, invalidLines } = parsePrometheusText(
      ['a 1.', 'b .5', 'c -2.5e-3', 'd +1E3', 'e 007', 'f 1.e2'].join('\n'),
    );
    expect(invalidLines).toBe(0);
    expect(samples.map((s) => s.value)).toEqual([1, 0.5, -0.0025, 1000, 7, 100]);
  });

  it('rejects huge digit runs in linear time', () => {
    // The previous value regex backtracked quadratically: 50k digits took seconds.
    const digits = '1'.repeat(100_000);
    const started = performance.now();
    const { samples, invalidLines } = parsePrometheusText(
      [`a ${digits}x`, `b ${digits}`, `c ${'1'.repeat(MAX_VALUE_LENGTH + 1)}`, `d ${'1'.repeat(MAX_VALUE_LENGTH)}`, 'e 1'].join('\n'),
    );
    expect(performance.now() - started).toBeLessThan(100);
    expect(samples.map((s) => s.name)).toEqual(['d', 'e']);
    expect(invalidLines).toBe(3);
  });

  it('skips overlong lines', () => {
    const label = 'x'.repeat(MAX_LINE_LENGTH);
    const { samples, invalidLines } = parsePrometheusText(`m{a="${label}"} 1\nok 1`);
    expect(samples.map((s) => s.name)).toEqual(['ok']);
    expect(invalidLines).toBe(1);
  });

  it('parses the Uptime Kuma fixture', () => {
    const { samples, invalidLines } = parsePrometheusText(fixture('uptimekuma-metrics.txt'));
    expect(invalidLines).toBe(0);
    const status = samples.filter((s) => s.name === 'monitor_status');
    expect(status).toHaveLength(5);
    expect(status[2]!.labels.monitor_name).toBe('API "v2"');
  });
});
