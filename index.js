/*
ocr to markdown in < 60 loc using llama-ocr with pdf support
*/

import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import { ocr } from 'llama-ocr';
import fs from 'fs';
import pdf from 'pdf-poppler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function convertPdfToImages(pdfPath) {
  const outputDir = path.join(__dirname, 'imgs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPrefix = path.parse(pdfPath).name;
  const options = {
    format: 'jpeg',
    out_dir: outputDir,
    out_prefix: outputPrefix,
    page: null,
  };

  await pdf.convert(pdfPath, options);
  return fs
    .readdirSync(outputDir)
    .filter((file) => file.startsWith(outputPrefix) && file.endsWith('.jpg'))
    .map((file) => path.join(outputDir, file));
}

async function processFile(filePath, apiKey) {
  const ext = path.extname(filePath).toLowerCase();
  let markdown = '';

  if (ext === '.pdf') {
    const imagePaths = await convertPdfToImages(filePath);
    if (!imagePaths.length) {
      console.log('No images generated from the PDF.');
      return;
    }
    for (const imagePath of imagePaths) {
      markdown += `${await ocr({ filePath: imagePath, apiKey })}\n`;
    }
  } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    markdown = await ocr({ filePath, apiKey });
  } else {
    throw new Error('Unsupported file type');
  }

  fs.writeFile('output.md', markdown, (err) => {
    if (err) throw err;
    console.log('output.md has been saved!');
  });
}

const filePath = './filepath';
const apiKey = process.env.TG_API_KEY;
processFile(filePath, apiKey);