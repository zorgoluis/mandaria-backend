import { appendFileSync } from 'node:fs';
const record = (data) => {
  if (process.env.C4_OBSERVER_PATH)
    appendFileSync(
      process.env.C4_OBSERVER_PATH,
      JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n',
    );
};
export default class C4Observer {
  onTestCaseReady(test) {
    record({ event: 'start', name: test.fullName });
  }
  onTestCaseResult(test) {
    record({
      event: 'finish',
      name: test.fullName,
      state: test.result().state,
    });
  }
  onTestRunEnd(_modules, errors, reason) {
    record({
      event: 'run-end',
      reason,
      unhandledErrors: errors.map((e) => ({
        name: e.name,
        message: String(e.message)
          .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[DATABASE_URL]')
          .replace(
            /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
            '[JWT]',
          ),
      })),
    });
  }
}
