import Groq from 'groq-sdk';
import pdf from 'pdf-poppler';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function convertPdfToImages(pdfPath) {
  const outputDir = path.join(__dirname, 'imgs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPrefix = path.basename(pdfPath, path.extname(pdfPath));
  const options = {
    format: 'jpeg',
    out_dir: outputDir,
    out_prefix: outputPrefix,
    page: null
  };

  await pdf.convert(pdfPath, options);

  const files = fs.readdirSync(outputDir);
  return files
    .filter(f => f.startsWith(outputPrefix) && f.endsWith('.jpg'))
    .map(f => path.join(outputDir, f));
}

async function groqOcr(filePath, model = 'llama-3.2-90b-vision-preview') {
  const groq = new Groq({ apiKey: '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' });
  const systemPrompt = `
Convert the provided image into Markdown format. Ensure that all content from the page is included, such as headers, footers, subtexts, images (with alt text if possible), tables, and any other elements.

Requirements:
- Output Only Markdown: Return solely the Markdown content without any additional explanations or comments.
- No Delimiters: Do not use code fences or delimiters like \`\`\`markdown.
- Complete Content: Do not omit any part of the page, including headers, footers, and subtext.
`;

  const finalImageUrl = isRemoteFile(filePath)
    ? filePath
    : `data:image/jpeg;base64,${encodeImage(filePath)}`;

  const response = await groq.chat.completions.create({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: systemPrompt },
          {
            type: 'image_url',
            image_url: { url: finalImageUrl },
          },
        ],
      },
    ],
    model,
    temperature: 1,
    max_tokens: 1024,
    top_p: 1,
    stream: false,
    stop: null,
  });

  return response.choices[0].message.content;
}

/**
 * Process any file (PDF or image) by converting PDFs to images, 
 * then OCR each image (or the file itself if it's an image).
 * Finally, concatenate results and save to output.md.
 */
async function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let markdown = '';

  if (ext === '.pdf') {
    const imagePaths = await convertPdfToImages(filePath);
    if (imagePaths.length === 0) {
      console.log('No images generated from the PDF.');
      return;
    }
    for (const imgPath of imagePaths) {
      const imgMarkdown = await groqOcr(imgPath);
      markdown += imgMarkdown + '\n';
    }
  } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    markdown = await groqOcr(filePath);
  } else {
    throw new Error('Unsupported file type');
  }

  fs.writeFileSync(path.join(__dirname, 'output.md'), markdown);
  console.log('output.md has been saved!');
}

/** Encode a local image to base64. */
function encodeImage(filePath) {
  const data = fs.readFileSync(filePath);
  return Buffer.from(data).toString('base64');
}

/** Check if the file path is a remote URL. */
function isRemoteFile(filePath) {
  return /^(http|https):\/\//i.test(filePath);
}

// Example usage:
(async () => {
  try {
    await processFile('filepath');
  } catch (error) {
    console.error('Error:', error);
  }
})();