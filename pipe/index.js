const { runPipe } = require('./lib/run');

async function main() {
  await runPipe();
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
};
