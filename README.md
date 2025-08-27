What This Code Does
This is a web server that handles image uploads in two different ways:
Main Features:

Takes Images Two Ways:

You can upload an image file directly from your computer
OR you can give it a web URL and it will download the image for you


Stores Images Safely:

Saves all images to cloud storage (Supabase)
Organizes them in folders by branch name and date
Gives each image a unique name so nothing gets overwritten
Returns a public web link to view the image


Security & Protection:

Requires a secret password (Bearer token) to use
Limits how many uploads someone can do per minute (30 max)
Only accepts image files (jpg, png, gif, webp)
Won't accept files bigger than 10MB


Smart Web Scraping:

When downloading from URLs, it acts like a real web browser
Can get past basic bot protection on websites
Handles cookies and redirects automatically
Tries multiple times if it fails


Image Proxy:

Has a separate feature to display images from other websites
Helpful when websites block direct image links
