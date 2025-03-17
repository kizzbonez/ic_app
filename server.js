require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(cors({
    origin: ['http://127.0.0.1:9292','https://italian-corners.myshopify.com','http://localhost:9292'],
    credentials: true
}));

// Shopify credentials
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Multer setup for file uploads (store in memory)
const upload = multer({ dest: 'uploads/' });

/**
 * Upload image to Shopify and return the image URL
 */

/**
 * Upload an image to Shopify for a specific product
 */
const uploadImageToShopify = async (imagePath, productId) => {
    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');

        // Upload image to Shopify for the specific product
        const response = await axios.post(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products/${productId}/images.json`,
            {
                image: {
                    attachment: base64Image
                }
            },
            {
                headers: {
                    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                    "Content-Type": "application/json"
                }
            }
        );

        // Extract and return the uploaded image URL
        return response.data.image.src;
    } catch (error) {
        console.error("Error uploading image to Shopify:", error.response?.data || error.message);
        throw new Error("Failed to upload image to Shopify.");
    }
};

/**
 * Create a new product with image uploads
 */
app.post('/create-product', upload.array('images', 5), async (req, res) => {
    try {
        const { title, body_html, price, storefront_user_id,size,bedrooms,baths } = req.body;

        if (!title || !price || !storefront_user_id) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Fetch customer details from Shopify to get user_type from notes
        const customerResponse = await axios.get(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/customers/search.json?query=email:${storefront_user_id}`,
            {
                headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
            }
        );

        // Extract user_type from customer notes
        const customer = customerResponse.data.customers[0];
        const user_type = customer?.note?.includes("user_type:private") ? "private" : "public";

        // Fetch user's existing products
        const shopifyResponse = await axios.get(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products.json?fields=id,tags`,
            {
                headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
            }
        );

        // Count products with the given storefront_user_id
        const userProducts = shopifyResponse.data.products.filter(product =>
            product.tags.includes(`storefront_user_id:${storefront_user_id}`)
        );

        // Restrict private users to a maximum of 2 products
        if (user_type === "private" && userProducts.length >= 2) {
            return res.status(403).json({ error: "Private users can only create up to 2 products." });
        }

        // Create the product in Shopify (without images)
        const createResponse = await axios.post(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products.json`,
            {
                product: {
                    title,
                    body_html,
                    variants: [{ price }],
                    tags: `storefront_user_id:${storefront_user_id}`,
                    metafields: [
                        {
                            namespace: "custom",
                            key: "size",
                            value: size.toString(),
                            type: "single_line_text_field"
                        },
                        {
                            namespace: "custom",
                            key: "bedrooms",
                            value: parseInt(bedrooms),
                            type: "number_integer"
                        },
                        {
                            namespace: "custom",
                            key: "baths",
                            value: baths.toString(),
                            type: "single_line_text_field"
                        }
                    ]
                }
            },
            {
                headers: {
                    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                    "Content-Type": "application/json"
                }
            }
        );

        const productId = createResponse.data.product.id;
        let productImages = [];

        // Upload images to Shopify for the created product
        if (req.files && req.files.length > 0) {
            const uploadedImageUrls = await Promise.all(req.files.map(file => uploadImageToShopify(file.path, productId)));
            productImages = uploadedImageUrls.map(url => ({ src: url }));

            // Delete temporary files after upload
            req.files.forEach(file => fs.unlinkSync(file.path));
        }

        res.status(201).json({ message: "Product created successfully", productId, images: productImages });
    } catch (error) {
        res.status(500).json({ error: error.response?.data || "Something went wrong" });
    }
});

/**
 * Update a product (only if the user owns it)
 */
app.put('/update-product/:product_id', upload.array('images', 5), async (req, res) => {
    try {
        const { product_id } = req.params;
        const { title, body_html, price, storefront_user_id } = req.body;

        if (!title || !price || !storefront_user_id) {
            return res.status(400).json({ error: "Missing required fields." });
        }

        // Fetch product details from Shopify
        const productResponse = await axios.get(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products/${product_id}.json`,
            {
                headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
            }
        );

        const product = productResponse.data.product;

        // Check if the product belongs to the requesting user
        if (!product.tags.includes(`storefront_user_id:${storefront_user_id}`)) {
            return res.status(403).json({ error: "You are not authorized to update this product." });
        }

        // Update product details in Shopify
        await axios.put(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products/${product_id}.json`,
            {
                product: {
                    title,
                    body_html,
                    variants: [{ id: product.variants[0].id, price }],
                    tags: `storefront_user_id:${storefront_user_id}`
                }
            },
            {
                headers: {
                    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                    "Content-Type": "application/json"
                }
            }
        );

        // Upload new images if provided
        let productImages = [];
        if (req.files && req.files.length > 0) {
            // Remove old images from Shopify
            if (product.images.length > 0) {
                await Promise.all(
                    product.images.map(async (img) => {
                        await axios.delete(
                            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products/${product_id}/images/${img.id}.json`,
                            {
                                headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
                            }
                        );
                    })
                );
            }

            // Upload new images
            const uploadedImageUrls = await Promise.all(
                req.files.map(file => uploadImageToShopify(file.path, product_id))
            );
            productImages = uploadedImageUrls.map(url => ({ src: url }));

            // Delete temporary files after upload
            req.files.forEach(file => fs.unlinkSync(file.path));
        }

        res.status(200).json({ message: "Product updated successfully", productId: product_id, images: productImages });
    } catch (error) {
        res.status(500).json({ error: error.response?.data || "Something went wrong" });
    }
});


/**
 * Retrieve products by storefront_user_id
 */
app.get('/products/:storefront_user_id', async (req, res) => {
    try {
        const { storefront_user_id } = req.params;

        // Fetch products (without metafields)
        const shopifyResponse = await axios.get(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products.json?fields=id,title,variants,tags,images`,
            {
                headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
            }
        );

        // Filter products by storefront_user_id (stored in tags)
        const filteredProducts = shopifyResponse.data.products.filter(product =>
            product.tags.includes(`storefront_user_id:${storefront_user_id}`)
        );

        // Fetch metafields for each product and merge with product data
        const productsWithMetafields = await Promise.all(
            filteredProducts.map(async (product) => {
                try {
                    const metafieldsResponse = await axios.get(
                        `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products/${product.id}/metafields.json`,
                        {
                            headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
                        }
                    );

                    return {
                        ...product,
                        metafields: metafieldsResponse.data.metafields // Attach metafields to the product
                    };
                } catch (error) {
                    console.error(`Error fetching metafields for product ${product.id}`, error);
                    return { ...product, metafields: [] }; // Return empty metafields on error
                }
            })
        );

        res.status(200).json({ products: productsWithMetafields });
    } catch (error) {
        res.status(500).json({ error: error.response?.data || "Something went wrong" });
    }
});


/**
 * Remove a product by product_id (only if the user owns it)
 */
app.delete('/remove-product/:product_id', async (req, res) => {
    try {
        const { product_id } = req.params;
        const { storefront_user_id } = req.body; // User ID requesting deletion

        if (!storefront_user_id) {
            return res.status(400).json({ error: "Missing storefront_user_id in request body." });
        }

        // Fetch product details from Shopify
        const productResponse = await axios.get(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products/${product_id}.json`,
            {
                headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
            }
        );

        const product = productResponse.data.product;

        // Check if the product belongs to the requesting user
        if (!product.tags.includes(`storefront_user_id:${storefront_user_id}`)) {
            return res.status(403).json({ error: "You are not authorized to delete this product." });
        }

        // Proceed with product deletion
        await axios.delete(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/products/${product_id}.json`,
            {
                headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
            }
        );

        res.status(200).json({ message: "Product removed successfully", product_id });
    } catch (error) {
        res.status(500).json({ error: error.response?.data || "Something went wrong" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
