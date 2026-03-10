/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",

  rootDir: __dirname,
  roots: ["<rootDir>"],
  testMatch: ["<rootDir>/tests/integration/**/*.integration.ts"],

  // Deliberately NO setupFilesAfterSetup — we need real fetch, real console
  collectCoverage: false,

  transform: {
    "^.+\\.(t|j)sx?$": [
      "ts-jest",
      {
        tsconfig: (() => {
          const base = require("./tsconfig.json");
          return {
            ...base.compilerOptions,
            allowJs: true,
          };
        })(),
      },
    ],
  },
  transformIgnorePatterns: ["/node_modules/(?!@aboutcircles/)"],
};
