import dotenv from 'dotenv';
dotenv.config();
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { processFile } from './routes';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.TOGETHERAI_API_KEY) {
  throw new Error('TOGETHERAI_API_KEY must be set');
}

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set');
}

// Singleton bot instance
let botInstance: TelegramBot | null = null;
let isPolling = false;
let reconnectTimeout: NodeJS.Timeout | null = null;

// Helper function to sanitize text and split into safe chunks
function splitTextIntoChunks(text: string, maxChunkSize: number = 4000): string[] {
  // Remove any markdown-like formatting that might cause parsing issues
  const sanitizedText = text
    .replace(/[*_`[\]()~>#+=|{}.!-]/g, '') // Remove markdown special characters
    .replace(/\n{3,}/g, '\n\n'); // Normalize multiple newlines

  const chunks: string[] = [];
  let currentChunk = '';

  const sentences = sanitizedText.split(/([.!?]+\s+)/);

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If a single sentence is longer than maxChunkSize, split it by words
      if (sentence.length > maxChunkSize) {
        const words = sentence.split(/\s+/);
        for (const word of words) {
          if (currentChunk.length + word.length + 1 > maxChunkSize) {
            chunks.push(currentChunk.trim());
            currentChunk = word;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + word;
          }
        }
      } else {
        currentChunk = sentence;
      }
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(chunk => chunk.length > 0);
}

function setupBotHandlers(bot: TelegramBot) {
  // Register command handlers
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'Welcome! Send me any PDF document or image (JPEG, PNG) and I will convert it to text using OCR.'
    );
  });

  // Add handler for text messages (excluding commands)
  bot.on('text', (msg) => {
    // Skip if it's a command (starts with '/')
    if (msg.text?.startsWith('/')) return;

    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'Please send me a PDF document or image (JPEG, PNG) to convert it to text. I cannot process plain text messages.'
    );
  });

  bot.on('document', async (msg) => {
    if (!msg.document) return;

    const chatId = msg.chat.id;
    const doc = msg.document;

    try {
      // Check file type
      const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png'];
      if (!allowedMimeTypes.includes(doc.mime_type || '')) {
        bot.sendMessage(chatId, 'Please send only PDF documents or images (JPEG, PNG).');
        return;
      }

      // Send processing message
      await bot.sendMessage(chatId, 'Processing your document...');

      // Download file
      const file = await bot.getFile(doc.file_id);
      const filePath = path.join(uploadDir, `${doc.file_id}${path.extname(doc.file_name || '.tmp')}`);

      // Download the file using node-fetch
      const response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(buffer));

      // Process the file
      const markdown = await processFile(filePath, process.env.TOGETHERAI_API_KEY!);

      // Split the text into safe chunks and send
      const chunks = splitTextIntoChunks(markdown);
      for (const chunk of chunks) {
        try {
          await bot.sendMessage(chatId, chunk);
          // Add a small delay between chunks to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (sendError) {
          console.error('Error sending message chunk:', sendError);
          try {
            await bot.sendMessage(chatId, 'Error sending part of the result. Some text might be missing.');
          } catch (notificationError) {
            console.error('Failed to send error notification:', notificationError);
          }
        }
      }

      // Clean up
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

    } catch (error: any) {
      console.error('Error processing document:', error);
      bot.sendMessage(
        chatId,
        'Sorry, there was an error processing your document. Please try again.'
      );
    }
  });

  bot.on('photo', async (msg) => {
    if (!msg.photo || msg.photo.length === 0) return;

    const chatId = msg.chat.id;
    const photo = msg.photo[msg.photo.length - 1]; // Get the highest resolution photo

    try {
      // Send processing message
      await bot.sendMessage(chatId, 'Processing your image...');

      // Download file
      const file = await bot.getFile(photo.file_id);
      const filePath = path.join(uploadDir, `${photo.file_id}.jpg`);

      // Download the file using node-fetch
      const response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(buffer));

      // Process the file
      const markdown = await processFile(filePath, process.env.TOGETHERAI_API_KEY!);

      // Split the text into safe chunks and send
      const chunks = splitTextIntoChunks(markdown);
      for (const chunk of chunks) {
        try {
          await bot.sendMessage(chatId, chunk);
          // Add a small delay between chunks to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (sendError) {
          console.error('Error sending message chunk:', sendError);
          try {
            await bot.sendMessage(chatId, 'Error sending part of the result. Some text might be missing.');
          } catch (notificationError) {
            console.error('Failed to send error notification:', notificationError);
          }
        }
      }

      // Clean up
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

    } catch (error: any) {
      console.error('Error processing image:', error);
      bot.sendMessage(
        chatId,
        'Sorry, there was an error processing your image. Please try again.'
      );
    }
  });
}

function stopBot() {
  if (botInstance) {
    console.log('Stopping Telegram bot...');
    botInstance.stopPolling();
    botInstance = null;
    isPolling = false;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

export function startTelegramBot() {
  // If a bot instance already exists, stop it first
  stopBot();

  // Create new bot instance
  botInstance = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });

  const startPolling = () => {
    if (!isPolling && botInstance) {
      console.log('Starting Telegram bot polling...');
      isPolling = true;
      botInstance.startPolling()
        .then(() => {
          console.log('Telegram bot started successfully');
          setupBotHandlers(botInstance!);
        })
        .catch((error) => {
          console.error('Failed to start bot polling:', error);
          isPolling = false;

          // Handle specific error cases
          if (error.code === 'ETELEGRAM' && error.response?.statusCode === 409) {
            console.log('Detected another bot instance, waiting 30 seconds before retry...');
            reconnectTimeout = setTimeout(startPolling, 30000);
          } else {
            console.log('Unknown error, retrying in 5 seconds...');
            reconnectTimeout = setTimeout(startPolling, 5000);
          }
        });
    }
  };

  // Handle bot errors
  botInstance.on('error', (error) => {
    console.error('Telegram bot error:', error);
    stopBot();
    reconnectTimeout = setTimeout(() => {
      console.log('Attempting to reconnect after error...');
      startTelegramBot();
    }, 5000);
  });

  // Handle polling errors
  botInstance.on('polling_error', (error: any) => {
    console.error('Telegram bot polling error:', error);
    isPolling = false;

    if (error.code === 'ETELEGRAM' && error.response?.statusCode === 409) {
      console.log('Conflict with another bot instance, waiting 30 seconds...');
      reconnectTimeout = setTimeout(startPolling, 30000);
    } else {
      console.log('Polling error, retrying in 5 seconds...');
      reconnectTimeout = setTimeout(startPolling, 5000);
    }
  });

  // Start initial polling
  startPolling();

  // Handle process termination
  process.on('SIGINT', () => {
    console.log('Received SIGINT signal, stopping bot...');
    stopBot();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('Received SIGTERM signal, stopping bot...');
    stopBot();
    process.exit(0);
  });
}