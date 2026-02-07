import ora from 'ora';

let quiet = false;

const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
};

export function setQuiet(value: boolean): void {
  quiet = value;
  if (value) {
    const noop = () => {};
    console.log = noop;
    console.error = noop;
    console.warn = noop;
    console.info = noop;
    console.debug = noop;
  } else {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
  }
}

export function isQuiet(): boolean {
  return quiet;
}

export function createSpinner(text: string): ora.Ora {
  return ora({ text, isSilent: quiet });
}
