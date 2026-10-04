/** unit: DB 없이 도는 테스트 / db: docker compose의 db-test(5433)가 필요한 테스트 */
const base = {
  // node16 모듈 설정에서 ts-jest가 내는 TS151002 경고는 무시(테스트 실행에는 영향 없음)
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: { ignoreCodes: [151002] } }] },
  testEnvironment: 'node',
  moduleNameMapper: { '^@minwon/contracts$': '<rootDir>/../../packages/contracts/src' },
};

module.exports = {
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/test/unit/**/*.spec.ts'] },
    {
      ...base,
      displayName: 'db',
      testMatch: ['<rootDir>/test/db/**/*.spec.ts'],
      globalSetup: '<rootDir>/test/db/global-setup.ts',
    },
  ],
};
