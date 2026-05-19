const { CustomFile } = require('telegram/client/uploads');
const { Buffer } = require('buffer');
try {
  const f = new CustomFile("test", 100, "", Buffer.alloc(100));
  console.log("Success with Buffer", Object.keys(f));
} catch(e) {
  console.log("Error", e.message);
}
