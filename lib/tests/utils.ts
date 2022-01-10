/* istanbul ignore file */

// Going to use jest.useFakeTimers, so store the real setTimeout here
const realTimeout = setTimeout;

let timeoutObjs: NodeJS.Timeout[];

// uses the real setTimeout and returns a Promise that resolves/rejects afer `milli` milliseconds
export const delayPromise = (milli: number, doReject = false) => new Promise((resolve, reject) => {
    // need to store timeout objects, so we can clear them after tests
    timeoutObjs.push(realTimeout(() => doReject ? reject() : resolve(undefined), milli));
});

// this runs a setTimeout(0) async loop until all timers are cleared,
// or the 4 second timeout is reached
export const waitForAllTimers = async () => {
    // to make sure the timers are added (timerCount > 0) we do a setTimeout(0) which schedules a macrotask
    await delayPromise(0);
    while (jest.getTimerCount() > 0) {
        await delayPromise(0);
        jest.runOnlyPendingTimers();
    }
};

beforeEach(() => {
    timeoutObjs = [];
});

afterEach(() => {
    jest.useRealTimers();
    // clear remaining (real) timers, otherwise the node process does not exit
    timeoutObjs.forEach(id => clearTimeout(id));
});
