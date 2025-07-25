// comment-server/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises'); // Use promises for async file operations

const app = express();
const PORT = 3100;
const COMMENTS_FILE = path.join(__dirname, 'comment.json');

app.use(cors()); // Allow cross-origin requests from your Theia app
app.use(express.json()); // Enable parsing JSON request bodies

// Helper function to read comments from the file
async function readComments() {
    try {
        const data = await fs.readFile(COMMENTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Comments file not found at ${COMMENTS_FILE}. Starting with empty array.`);
            return []; // Return empty array if file doesn't exist
        }
        console.error('Error reading comments file:', error);
        throw error;
    }
}

// Helper function to write comments to the file
async function writeComments(comments) {
    try {
        await fs.writeFile(COMMENTS_FILE, JSON.stringify(comments, null, 2), 'utf8');
    } catch (error) {
        console.error('Error writing comments file:', error);
        throw error;
    }
}

// Endpoint to get comments
app.get('/comment.json', async (req, res) => {
    try {
        const comments = await readComments();
        res.json(comments);
    } catch (error) {
        res.status(500).send('Error fetching comments.');
    }
});

// Endpoint to add a comment
app.post('/comments', async (req, res) => {
    const newComment = req.body;
    if (!newComment.id || !newComment.file || !newComment.type || !newComment.content || !newComment.anchor) {
        return res.status(400).send('Invalid comment data provided.');
    }

    try {
        const comments = await readComments();
        comments.push(newComment); // Add the new comment
        await writeComments(comments);
        res.status(201).json(newComment); // Respond with the created comment
        console.log(`Added comment: ${newComment.id} for file ${newComment.file}`);
    } catch (error) {
        res.status(500).send('Error adding comment.');
    }
});

// Endpoint to delete a comment
app.delete('/comments/:id', async (req, res) => {
    const commentId = req.params.id;
    try {
        let comments = await readComments();
        const initialLength = comments.length;
        comments = comments.filter(comment => comment.id !== commentId); // Filter out the comment

        if (comments.length < initialLength) {
            await writeComments(comments);
            res.status(204).send(); // No Content, indicates successful deletion
            console.log(`Resolved (deleted) comment with ID: ${commentId}`);
        } else {
            res.status(404).send('Comment not found.');
        }
    } catch (error) {
        res.status(500).send('Error deleting comment.');
    }
});

app.listen(PORT, () => {
    console.log(`Comment server running on http://localhost:${PORT}`);
});