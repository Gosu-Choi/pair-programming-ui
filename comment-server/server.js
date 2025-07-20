const express = require('express');
const cors = require('cors');
const app = express();
const port = 3100;

app.use(cors());
app.use(express.static(__dirname)); // comment.json이 있는 디렉토리

app.listen(port, () => {
    console.log(`Comment server running at http://localhost:${port}`);
});