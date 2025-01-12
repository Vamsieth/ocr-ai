import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { ocr } from "llama-ocr";
import fs from "fs";
import { fromPath } from "pdf2pic";
import * as sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(file.mimetype)) {
      cb(new Error('Invalid file type. Only JPG, PNG and PDF files are allowed.'));
      return;
    }
    cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
  }
});

async function compressImage(inputPath: string, outputPath: string): Promise<void> {
  try {
    await sharp.default(inputPath)
      .resize(1800, 2400, { // Reasonable size for OCR while maintaining quality
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality: 80,
        progressive: true,
      })
      .toFile(outputPath);
  } catch (error) {
    console.error('Image compression failed:', error);
    throw error;
  }
}

export async function processFile(filePath: string, apiKey: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  let markdown = "";

  try {
    if (ext === ".pdf") {
      const options = {
        density: 100,
        saveFilename: "page",
        savePath: uploadDir,
        format: "png",
        width: 2480,
        height: 3508
      };

      const convert = fromPath(filePath, options);
      let fullText = "";

      // Convert and process each page
      const pageToConvertAsImage = await convert.bulk(-1); // -1 means convert all pages

      for (const page of pageToConvertAsImage) {
        // Construct the correct file path: page.1.png, page.2.png, etc.
        const imagePath = path.join(uploadDir, `page.${page.page}.png`);
        const compressedImagePath = path.join(uploadDir, `compressed_${page.page}.jpg`);

        // Compress the image before OCR
        await compressImage(imagePath, compressedImagePath);

        // Process the compressed image with OCR
        const pageText = await ocr({ filePath: compressedImagePath, apiKey });
        fullText += pageText + "\n\n";

        // Clean up temporary images
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
        if (fs.existsSync(compressedImagePath)) {
          fs.unlinkSync(compressedImagePath);
        }
      }

      markdown = fullText.trim();
    } else if ([".jpg", ".jpeg", ".png"].includes(ext)) {
      // For direct image uploads, compress before OCR
      const compressedImagePath = path.join(uploadDir, `compressed_${path.basename(filePath)}`);
      await compressImage(filePath, compressedImagePath);

      markdown = await ocr({ filePath: compressedImagePath, apiKey });

      // Clean up compressed image
      if (fs.existsSync(compressedImagePath)) {
        fs.unlinkSync(compressedImagePath);
      }
    } else {
      throw new Error("Unsupported file type");
    }
    return markdown;
  } catch (error: any) {
    throw new Error(`Failed to process file: ${error.message}`);
  }
}

export function registerRoutes(app: Express): Server {
  const httpServer = createServer(app);

  app.post("/api/ocr", upload.single("file"), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const apiKey = process.env.TOGETHERAI_API_KEY;
      if (!apiKey) {
        throw new Error("TogetherAI API key not configured");
      }

      const markdown = await processFile(file.path, apiKey);

      // Clean up uploaded file
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }

      res.json({ markdown });
    } catch (error: any) {
      // Clean up uploaded file on error
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({ message: error.message });
    }
  });

  return httpServer;
}