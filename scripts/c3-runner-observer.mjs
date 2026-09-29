import { appendFileSync } from 'node:fs';
const record = (event, test) => {
  if (process.env.C3_OBSERVER_PATH)
    appendFileSync(
      process.env.C3_OBSERVER_PATH,
      JSON.stringify({
        at: new Date().toISOString(),
        event,
        name: test.fullName,
        state: event === 'finish' ? test.result().state : undefined,
      }) + '\n',
    );
};
export default class C3Observer {
  onTestCaseReady(test) {
    record('start', test);
  }
  onTestCaseResult(test) {
    record('finish', test);
  }
}
