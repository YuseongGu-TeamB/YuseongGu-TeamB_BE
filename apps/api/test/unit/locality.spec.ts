import { loadEnv } from '../../src/config/env';
import { keywordsOf } from '../../src/corpus/corpus.repository';
import { assertRequiredLocal, hostOf, isLocalAddress, isLocalHost } from '../../src/health/locality';

const env = (over: Record<string, string> = {}) => loadEnv({ DATABASE_URL: 'postgresql://app:app@localhost:5432/minwon', ...over });

describe('로컬 판정', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1'])(
    '로컬: %s',
    (ip) => expect(isLocalAddress(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '172.32.0.1', '172.15.0.1', '1.1.1.1', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('외부: %s', (ip) =>
    expect(isLocalAddress(ip)).toBe(false),
  );

  it('localhost는 로컬', async () => {
    expect(await isLocalHost('localhost')).toBe(true);
  });

  it('해석할 수 없는 이름은 로컬이 아닌 것으로 본다', async () => {
    expect(await isLocalHost('no-such-host.invalid')).toBe(false);
  });

  it('URL에서 호스트를 꺼낸다', () => {
    expect(hostOf('postgresql://app:app@localhost:5432/minwon')).toBe('localhost');
    expect(hostOf('https://ollama.com/v1')).toBe('ollama.com');
    expect(hostOf('http://[::1]:11434/v1')).toBe('::1');
  });
});

describe('REQUIRE_LOCAL', () => {
  it('기본값(db,embedding)이 로컬이면 통과 — LLM은 외부여도 된다', async () => {
    await expect(assertRequiredLocal(env({ OPENAI_BASE_URL: 'http://8.8.8.8/v1' }))).resolves.toBeUndefined();
  });

  it('임베딩이 외부면 시작 중단', async () => {
    await expect(assertRequiredLocal(env({ EMBEDDING_BASE_URL: 'http://8.8.8.8/v1' }))).rejects.toThrow(/embedding\(8\.8\.8\.8\)/);
  });

  it('llm을 포함하면 LLM도 로컬이어야 한다', async () => {
    await expect(
      assertRequiredLocal(env({ REQUIRE_LOCAL: 'db,embedding,llm', OPENAI_BASE_URL: 'http://8.8.8.8/v1' })),
    ).rejects.toThrow(/llm\(8\.8\.8\.8\)/);
  });

  it('DB가 외부면 시작 중단', async () => {
    await expect(assertRequiredLocal(env({ DATABASE_URL: 'postgresql://a:b@8.8.4.4:5432/x' }))).rejects.toThrow(/db\(8\.8\.4\.4\)/);
  });

  it('알 수 없는 구성요소 이름은 설정 오류', () => {
    expect(() => env({ REQUIRE_LOCAL: 'db,gpu' })).toThrow(/REQUIRE_LOCAL/);
  });
});

describe('키워드 폴백 핵심어', () => {
  it('2자 이상 단어, 중복 제거', () => {
    expect(keywordsOf('저녁 유예, 유예 시간에 단속? 왜!')).toEqual(['저녁', '유예', '시간에', '단속']);
  });
});
