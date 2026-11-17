import { describe, expect, it } from 'vitest';
import { parsePrometheusText } from '../../src/adapters/prometheus.js';
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

  it('parses the Uptime Kuma fixture', () => {
    const { samples, invalidLines } = parsePrometheusText(fixture('uptimekuma-metrics.txt'));
    expect(invalidLines).toBe(0);
    const status = samples.filter((s) => s.name === 'monitor_status');
    expect(status).toHaveLength(5);
    expect(status[2]!.labels.monitor_name).toBe('API "v2"');
  });
});
