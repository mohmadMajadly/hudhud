// Quick start: one call opens a session in the current directory with the
// safe defaults, one question, then a graceful close.
// Guide: docs/guide/getting-started.md

import { hudhud } from 'hudhudjs';

const session = await hudhud.session();
try {
  const result = await session.ask('List the files in this directory and say what the project is.');
  if (result.isError) {
    console.error(`The turn ended with outcome ${result.outcome}:`, result.errors ?? []);
  } else {
    console.log(result.text);
  }
} finally {
  await session.close();
}
