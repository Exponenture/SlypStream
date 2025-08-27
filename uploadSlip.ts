import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// CORS headers for all responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};
// Rate limiting store (in-memory for this example)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute per IP
// Utility functions
const normalize = (str)=>str.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
const maskSensitiveData = (data)=>{
  if (typeof data === 'string') {
    if (data.includes('Bearer')) return data.substring(0, 10) + '***';
    if (data.includes('http')) return data.substring(0, 30) + '***';
    if (data.length > 50) return data.substring(0, 20) + '***';
  }
  return data;
};
const safeStringify = (error)=>{
  return error instanceof Error ? error.message : String(error);
};
// Enhanced cookie parser with fallbacks
const extractCookies = (response)=>{
  const cookies = [];
  // Try modern getSetCookie method first
  try {
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    setCookieHeaders.forEach((cookieHeader)=>{
      const cookiePair = cookieHeader.split(';')[0];
      if (cookiePair) cookies.push(cookiePair);
    });
  } catch (error) {
    console.log('getSetCookie not available, falling back to manual parsing');
  }
  // Fallback to manual header parsing if no cookies found
  if (cookies.length === 0) {
    const setCookieHeader = response.headers.get('Set-Cookie');
    if (setCookieHeader) {
      setCookieHeader.split(',').forEach((cookie)=>{
        const cookiePair = cookie.trim().split(';')[0];
        if (cookiePair) cookies.push(cookiePair);
      });
    }
  }
  return cookies;
};
// Rate limiting function
const checkRateLimit = (clientIP)=>{
  const now = Date.now();
  const clientData = rateLimitStore.get(clientIP) || {
    requests: [],
    lastCleanup: now
  };
  // Clean old requests outside the window
  clientData.requests = clientData.requests.filter((timestamp)=>now - timestamp < RATE_LIMIT_WINDOW);
  if (clientData.requests.length >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      resetTime: clientData.requests[0] + RATE_LIMIT_WINDOW
    };
  }
  clientData.requests.push(now);
  rateLimitStore.set(clientIP, clientData);
  // Cleanup old entries periodically
  if (now - clientData.lastCleanup > RATE_LIMIT_WINDOW) {
    for (const [ip, data] of rateLimitStore.entries()){
      if (now - data.lastCleanup > RATE_LIMIT_WINDOW * 2) {
        rateLimitStore.delete(ip);
      }
    }
    clientData.lastCleanup = now;
  }
  return {
    allowed: true
  };
};
// Validation functions
const validateUploadData = (uploadData)=>{
  const errors = [];
  if (!uploadData.branch) errors.push('branch is required');
  if (!uploadData.date) errors.push('date is required');
  if (!uploadData.filename) errors.push('filename is required');
  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (uploadData.date && !dateRegex.test(uploadData.date)) {
    errors.push('Date must be in YYYY-MM-DD format');
  }
  // Validate filename format and extension
  const validFilenamePattern = /^[a-zA-Z0-9\-_]+\.(jpg|jpeg|png|gif|webp)$/i;
  if (uploadData.filename && !validFilenamePattern.test(uploadData.filename)) {
    errors.push('Filename format invalid. Only alphanumeric characters, dashes, and underscores allowed with valid image extensions (jpg, jpeg, png, gif, webp).');
  }
  return errors;
};
const validateImageSize = (imageData, maxSizeBytes = 10 * 1024 * 1024)=>{
  if (imageData.length > maxSizeBytes) {
    return `Image too large. Maximum size is ${maxSizeBytes / 1024 / 1024}MB`;
  }
  return null;
};
// Filename processing
const generateFinalFilename = (originalFilename)=>{
  let finalFilename = originalFilename;
  // Ensure filename ends with .jpg for consistency
  if (!finalFilename.toLowerCase().endsWith('.jpg')) {
    finalFilename = finalFilename.replace(/\.[^/.]+$/, '') + '.jpg';
  }
  // Add unique suffix to prevent accidental overwrites
  const uniqueSuffix = crypto.randomUUID().slice(0, 8);
  finalFilename = finalFilename.replace(/\.jpg$/, `_${uniqueSuffix}.jpg`);
  return finalFilename;
};
// Logging helper
const logUploadMetadata = (uploadData, finalFilename, storagePath, contentTypeHeader, uploadMode, imageSizeBytes)=>{
  const normalizedBranch = normalize(uploadData.branch);
  console.log('Upload metadata:', {
    branch: uploadData.branch,
    normalizedBranch,
    date: uploadData.date,
    originalFilename: uploadData.filename,
    finalFilename,
    storagePath,
    contentTypeHeader,
    uploadMode,
    imageSizeBytes,
    originalUrl: uploadMode === 'url-upload' ? maskSensitiveData(uploadData.imageUrl) : 'direct-upload'
  });
};
// Enhanced session-based image fetching with multi-step bot protection handling
const fetchImageWithSessionHandling = async (url, maxRetries = 3)=>{
  console.log(`Attempting to fetch image from: ${maskSensitiveData(url)}`);
  for(let attempt = 1; attempt <= maxRetries; attempt++){
    console.log(`Fetch attempt ${attempt}/${maxRetries}`);
    try {
      // Step 1: Visit the main domain first to establish session
      const baseDomain = new URL(url).origin;
      console.log(`Step 1: Establishing session with base domain: ${baseDomain}`);
      const domainResponse = await fetch(baseDomain, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Cache-Control': 'max-age=0'
        }
      });
      let sessionCookies = extractCookies(domainResponse);
      console.log(`Domain visit: ${domainResponse.status}, extracted ${sessionCookies.length} cookies`);
      // Step 2: Make initial request to the image URL to trigger any additional protection
      console.log(`Step 2: Initial image URL request`);
      const initialResponse = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'same-origin',
          'Referer': baseDomain,
          'Cookie': sessionCookies.join('; '),
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      console.log(`Initial image request: ${initialResponse.status} ${initialResponse.statusText}`);
      // Extract any additional cookies from the image request
      const additionalCookies = extractCookies(initialResponse);
      const allCookies = [
        ...new Set([
          ...sessionCookies,
          ...additionalCookies
        ])
      ]; // Merge and dedupe
      console.log(`Total cookies after image request: ${allCookies.length}`);
      let targetUrl = url;
      // Step 3: Handle redirect if present
      if (initialResponse.status === 301 || initialResponse.status === 302) {
        const location = initialResponse.headers.get('Location');
        if (location) {
          targetUrl = location.startsWith('http') ? location : new URL(location, url).href;
          console.log(`Step 3: Following redirect to: ${maskSensitiveData(targetUrl)}`);
          // If redirect is to a gateway/verification page, visit it first
          if (targetUrl.includes('gog/redirect') || targetUrl.includes('redirect')) {
            console.log(`Step 3a: Visiting verification page`);
            const verificationResponse = await fetch(targetUrl, {
              method: 'GET',
              redirect: 'follow',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Referer': baseDomain,
                'Cookie': allCookies.join('; ')
              }
            });
            const verificationCookies = extractCookies(verificationResponse);
            allCookies.push(...verificationCookies);
            console.log(`Verification page: ${verificationResponse.status}, total cookies: ${allCookies.length}`);
            // Wait a moment to simulate human behavior
            await new Promise((resolve)=>setTimeout(resolve, 1500));
          }
        }
      }
      // Step 4: Final attempt to get the actual image
      console.log(`Step 4: Final image request`);
      const finalOptions = {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'same-origin',
          'Referer': baseDomain,
          'Cookie': [
            ...new Set(allCookies)
          ].join('; ') // Dedupe cookies
        }
      };
      const finalResponse = await fetch(url, finalOptions);
      console.log(`Final response: ${finalResponse.status} ${finalResponse.statusText}`);
      if (finalResponse.ok) {
        const contentType = finalResponse.headers.get('Content-Type');
        // Check if we actually got an image or another HTML challenge
        if (!contentType?.startsWith('image/')) {
          console.log(`Warning: Response content-type is ${contentType}, checking response body`);
          const responseText = await finalResponse.text();
          // If it's HTML, it's likely still a challenge page
          if (responseText.includes('<!DOCTYPE html') || responseText.includes('<html')) {
            console.log(`Still receiving HTML challenge page, attempt ${attempt}`);
            if (attempt === maxRetries) {
              return {
                success: false,
                error: 'Unable to bypass bot protection after multiple attempts',
                details: responseText.substring(0, 300),
                finalUrl: maskSensitiveData(finalResponse.url)
              };
            }
            continue; // Retry
          }
        }
        const imageData = new Uint8Array(await finalResponse.arrayBuffer());
        const finalContentType = contentType?.startsWith('image/') ? contentType : 'application/octet-stream';
        console.log(`Successfully fetched image: ${imageData.length} bytes, content-type: ${finalContentType}`);
        return {
          success: true,
          data: imageData,
          contentType: finalContentType
        };
      } else {
        console.log(`Request failed with status ${finalResponse.status}, will retry if attempts remaining`);
        if (attempt === maxRetries) {
          const responseText = await finalResponse.text().catch(()=>'Unable to read response body');
          return {
            success: false,
            error: `Failed to fetch image: ${finalResponse.status} ${finalResponse.statusText}`,
            details: responseText.substring(0, 300),
            finalUrl: maskSensitiveData(finalResponse.url)
          };
        }
      }
    } catch (error) {
      console.error(`Attempt ${attempt} failed with error:`, safeStringify(error));
      if (attempt === maxRetries) {
        return {
          success: false,
          error: 'Network error while fetching image',
          details: safeStringify(error)
        };
      }
    }
    // Wait before retrying with exponential backoff
    if (attempt < maxRetries) {
      const waitTime = 1000 * attempt; // 1s, 2s, 3s
      console.log(`Waiting ${waitTime}ms before retry...`);
      await new Promise((resolve)=>setTimeout(resolve, waitTime));
    }
  }
};
// Main image processing function
const processImageUpload = async (uploadData, imageFile, supabase)=>{
  let imageData;
  let contentTypeHeader = 'application/octet-stream'; // More appropriate default
  let uploadMode;
  if (imageFile) {
    // Direct file upload
    imageData = new Uint8Array(await imageFile.arrayBuffer());
    contentTypeHeader = imageFile.type || 'application/octet-stream';
    uploadMode = 'direct-upload';
    console.log(`Processing direct file upload: ${imageFile.name}`);
  } else if (uploadData.imageUrl) {
    // URL-based upload with enhanced session handling
    console.log(`Fetching image from URL with session handling`);
    const fetchResult = await fetchImageWithSessionHandling(uploadData.imageUrl);
    if (!fetchResult.success) {
      // Check if this is a bot protection issue
      if (fetchResult.details?.includes('<!DOCTYPE html') || fetchResult.details?.includes('<html')) {
        console.log('Bot protection detected for URL:', maskSensitiveData(uploadData.imageUrl));
        return {
          success: false,
          error: 'Bot protection detected - unable to fetch image',
          details: 'The source URL is protected by bot detection systems. Please contact support for integration options.',
          suggestion: 'Consider API token authentication, webhook integration, or direct storage access',
          contactInfo: 'Request integration support to bypass bot protection',
          originalError: fetchResult.error
        };
      }
      return {
        success: false,
        error: fetchResult.error,
        details: fetchResult.details,
        finalUrl: fetchResult.finalUrl
      };
    }
    imageData = fetchResult.data;
    contentTypeHeader = fetchResult.contentType;
    uploadMode = 'url-upload';
  } else {
    return {
      success: false,
      error: 'Either imageUrl or image file must be provided'
    };
  }
  // Validate image size
  const sizeError = validateImageSize(imageData);
  if (sizeError) {
    return {
      success: false,
      error: sizeError
    };
  }
  // Generate final filename and storage path
  const finalFilename = generateFinalFilename(uploadData.filename);
  const normalizedBranch = normalize(uploadData.branch);
  const storagePath = `${normalizedBranch}/${uploadData.date}/${finalFilename}`;
  // Log upload metadata
  logUploadMetadata(uploadData, finalFilename, storagePath, contentTypeHeader, uploadMode, imageData.length);
  console.log(`Uploading to storage path: ${storagePath}`);
  // Upload to Supabase Storage
  const { data: uploadResult, error: uploadError } = await supabase.storage.from('edge-slips').upload(storagePath, imageData, {
    contentType: contentTypeHeader,
    upsert: false
  });
  if (uploadError) {
    console.error('Supabase storage upload error:', uploadError);
    return {
      success: false,
      error: 'Failed to upload image to storage',
      details: uploadError.message
    };
  }
  console.log('Upload successful:', uploadResult);
  // Get the public URL
  const { data: urlData } = supabase.storage.from('edge-slips').getPublicUrl(storagePath);
  const publicUrl = urlData.publicUrl;
  console.log(`Upload completed successfully. Public URL: ${maskSensitiveData(publicUrl)}`);
  return {
    success: true,
    publicUrl,
    metadata: {
      finalFilename,
      storagePath,
      imageSizeBytes: imageData.length,
      uploadMode
    }
  };
};
// Main serve function
serve(async (req)=>{
  const url = new URL(req.url);
  // 🆕 IMAGE PROXY ENDPOINT - Handle this first
  if (req.method === 'GET' && url.pathname.startsWith('/image-proxy')) {
    try {
      const imageUrl = url.searchParams.get('url');
      if (!imageUrl) {
        return new Response('Missing image URL parameter', {
          status: 400,
          headers: {
            'Content-Type': 'text/plain'
          }
        });
      }
      console.log(`Proxying image: ${maskSensitiveData(imageUrl)}`);
      // Fetch the image with proper headers
      const imageResponse = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Slypstream-ImageProxy/1.0)',
          'Accept': 'image/*,*/*;q=0.8',
          'Cache-Control': 'no-cache'
        }
      });
      if (!imageResponse.ok) {
        console.error(`Failed to fetch image: ${imageResponse.status}`);
        return new Response(`Failed to fetch image: ${imageResponse.status}`, {
          status: imageResponse.status,
          headers: {
            'Content-Type': 'text/plain'
          }
        });
      }
      // Return the image with proper headers
      return new Response(imageResponse.body, {
        status: 200,
        headers: {
          'Content-Type': imageResponse.headers.get('Content-Type') || 'image/jpeg',
          'Content-Length': imageResponse.headers.get('Content-Length'),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch (error) {
      console.error('Image proxy error:', error);
      return new Response(`Proxy error: ${error.message}`, {
        status: 500,
        headers: {
          'Content-Type': 'text/plain'
        }
      });
    }
  }
  // Handle CORS preflight for proxy endpoint
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/image-proxy')) {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }
  // Handle CORS preflight requests for upload endpoint
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }
  // Only allow POST requests for upload functionality
  if (req.method !== 'POST') {
    console.error(`Method ${req.method} not allowed`);
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  try {
    // Rate limiting check
    const clientIP = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const rateLimitResult = checkRateLimit(clientIP);
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({
        error: 'Rate limit exceeded',
        resetTime: new Date(rateLimitResult.resetTime).toISOString()
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000))
        }
      });
    }
    // Validate environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const uploadSecret = Deno.env.get('UPLOAD_SECRET');
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey || !uploadSecret) {
      console.error('Missing required environment variables');
      return new Response(JSON.stringify({
        error: 'Server configuration error'
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Validate Authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('Missing or invalid Authorization header');
      return new Response(JSON.stringify({
        error: 'Unauthorized - Bearer token required'
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const token = authHeader.substring(7);
    if (token !== uploadSecret) {
      console.error('Invalid upload secret provided');
      return new Response(JSON.stringify({
        error: 'Unauthorized - Invalid token'
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`
        }
      }
    });
    // Parse request data
    let uploadData;
    let imageFile = null;
    const contentType = req.headers.get('Content-Type') || '';
    if (contentType.includes('multipart/form-data')) {
      // Handle form data (direct file upload)
      const formData = await req.formData();
      imageFile = formData.get('image');
      uploadData = {
        branch: formData.get('branch'),
        date: formData.get('date'),
        filename: formData.get('filename')
      };
      if (!imageFile) {
        console.error('No image file provided in form data');
        return new Response(JSON.stringify({
          error: 'Image file is required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      console.log(`Received file upload: ${imageFile.name}, size: ${imageFile.size} bytes`);
    } else {
      // Handle JSON data (URL-based upload)
      try {
        uploadData = await req.json();
      } catch (error) {
        console.error('Invalid JSON in request body:', safeStringify(error));
        return new Response(JSON.stringify({
          error: 'Invalid JSON in request body'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }
    // Validate upload data
    const validationErrors = validateUploadData(uploadData);
    if (validationErrors.length > 0) {
      console.error('Validation errors:', validationErrors);
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: validationErrors
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    console.log(`Branch normalized: "${uploadData.branch}" -> "${normalize(uploadData.branch)}"`);
    // Process the image upload
    const uploadResult = await processImageUpload(uploadData, imageFile, supabase);
    if (!uploadResult.success) {
      return new Response(JSON.stringify({
        error: uploadResult.error,
        details: uploadResult.details,
        finalUrl: uploadResult.finalUrl
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Return success response
    const response = {
      message: 'Upload successful',
      url: uploadResult.publicUrl,
      metadata: {
        ...uploadResult.metadata,
        originalUrl: uploadData.imageUrl ? maskSensitiveData(uploadData.imageUrl) : 'direct-upload'
      }
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Unexpected error in upload function:', safeStringify(error));
    return new Response(JSON.stringify({
      error: 'Internal server error',
      details: safeStringify(error)
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
