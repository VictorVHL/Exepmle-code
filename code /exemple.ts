import express, {Request, Response} from 'express';

import { BadRequestError, BooleanProperty, CustomersNetworkManager, PageToken, PermissionError, PropertiesManager, PropertyParam, PropertyType, TextProperty, UserRole, validatePagePermissions, validateRequest, ValidProperty } from '@cherrypie/feedc.common';
import { PostPropertyEntity } from '../../entities/PostPropertyEntity';
import { PostStatus } from '../../models/enums/PostStatus';
import { body } from 'express-validator';
import { IPost, Post } from '../../entities/mongodb/Post';
import { PostsHelper } from '../../services/PostsHelper';
import { ICaptcha } from '../../models/params/ICaptcha';
import { RecaptchaManager } from '../../services/RecaptchaManager';
import { Image } from '../../services/ShareImage';
import { createNotifications } from './Notifications';
import { NotificationType } from '../../models/enums/NotificationType';
import { createPostCategory, deleteOldCategory, checkOnPost } from '../../services/PostCategoryManager';
import { PostCategory } from '../../entities/mongodb/PostCategory';

const router = express.Router();

router.post(
    '/api/v4/pages/:pageId/posts', 
    [
        body('postType')
            .notEmpty()
            .withMessage('postType param is required')
    ],
    validateRequest,
    validatePagePermissions(true, true, true, [UserRole.ADMIN, UserRole.CREATOR], false),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const postTypeId = +req.body.postType;
        const captcha: ICaptcha | undefined = req.body.captcha;
        let customerId: string;
        let customer: any;
        let title: string;
        let name: string;
        let accessToken = req.accessTokenString!

        if (req.customerAccessToken){
            customerId = req.customerAccessToken.customerId;
        }
        else if (req.body?.customerId) {
            customerId = req.body?.customerId;
        }
        else {
            throw new BadRequestError('Post author is not defined'); 
        }

        customer = await CustomersNetworkManager.getCustomer(pageId, customerId, req.accessTokenString!, true);
        if (!customer){
            throw new BadRequestError('Post author is not defined'); 
        }

        if (pageId == 1){
            let isRss = false;
            customer.properties.map(async (property: any) => {
                if(property.id == 20 && property.value !== true ) {
                    isRss = true;
                }
                if(property.id == 1 ) {
                    name = property.value;
                }
            });

            if (isRss){
                // no need to check captcha
            }
            else if (captcha == undefined){
                throw new BadRequestError('Captcha is missing');
            }
            else {
                const isCaptchaCorrect = await RecaptchaManager.verify(captcha);
                console.log('isCaptchaCorrect:', isCaptchaCorrect);
                if (!isCaptchaCorrect){
                    throw new BadRequestError('Captcha is wrong'); 
                }
            }
        }
        else if (captcha == undefined){
            throw new BadRequestError('Captcha is missing');
        }

        const pageProperties = await PostPropertyEntity.find({ where: { pageId: pageId, postType: postTypeId } })
        const properties: PropertyParam[] = req.body.properties;

        const validProperties = PropertiesManager.validateProperties(pageProperties, properties, true);
        if (validProperties instanceof Error){
            throw validProperties;
        }

        // check for spam
        let postsCount = 0;
        try {
            const MS_PER_MINUTE = 60000;
            const fromDate = new Date(Date.now() - 30 * MS_PER_MINUTE);
            postsCount = await Post.countDocuments({pageId: pageId, postType: postTypeId, ownerId: customerId, createdAt: {'$gte': fromDate}});
        } catch (err) {
            throw new BadRequestError('Bad request');
        }
        if (postsCount >= 5){
            const error = new BadRequestError('Posts limit reached. Try again a bit later.');
            error.statusCode = 499;
            throw error;
        }

        const post = new Post({ pageId: pageId, ownerId: customerId, postType: postTypeId, properties: {} });
        post.createdAt = new Date();
        for (const validProperty of validProperties) {
            let userCanUpdate = true;

            for (const pageProperty of pageProperties) {
                if (pageProperty.id == validProperty.id){
                    userCanUpdate = pageProperty.userCanUpdate;
                }
            }

            if (userCanUpdate){
                if(validProperty.id == 2) {
                  title = validProperty.value.toJSON();
                }
                if(validProperty.id == 3) {
                    const image = new Image;
                    await image.ShareImage(validProperty, accessToken, title!, name! );
                }
                if(validProperty.id == 37) {
                    for (let object in validProperty.value.toJSON()) {
                        await createPostCategory(post._id, object, post.properties[7].value);
                      }
                }

                post.properties[validProperty.id] = {id:validProperty.id, name:validProperty.name, type:validProperty.type, value:validProperty.value.toJSON()};
            }
        }
        await post.save();
        await createNotifications(pageId, 'Your post was successfully published', post.id, NotificationType.NEWPOST, accessToken);

        const response = {
            post: post
        };

        res.status(200).send(response);
    }
);

router.delete(
    '/api/v4/pages/:pageId/posts/:postId', 
    validatePagePermissions(true, true, true, [UserRole.ADMIN], false),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const postId = req.params?.postId;

        const post = await Post.findById(postId);
        if (!post || post.pageId != pageId || post.status == PostStatus.REMOVED){
            throw new BadRequestError('Post not found');
        }

        if (req.customerAccessToken && req.customerAccessToken.customerId!=post.ownerId){
            throw new PermissionError();
        }

        post.status = PostStatus.REMOVED;
        await post.save();

        await PostCategory.deleteMany({ postId: postId })

        res.status(200).send();
    }
);

router.put(
    '/api/v4/pages/:pageId/posts/:postId', 
    validatePagePermissions(true, true, true, [UserRole.ADMIN], false),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const postId = req.params?.postId;
        let title: string;
        let name: string;
        let accessToken = req.accessTokenString!
        let customerId: string;
        let customerAccessToken = req.customerAccessToken;

        const post = await Post.findById(postId);
        if (!post || post.pageId != pageId || post.status == PostStatus.REMOVED){
            throw new BadRequestError('Post not found');
        }

        if (req.customerAccessToken && req.customerAccessToken.customerId!=post.ownerId){
            throw new PermissionError();
        }

        if (req.customerAccessToken){
            customerId = req.customerAccessToken.customerId;
        }

        if (customerAccessToken) {
            const customer = await CustomersNetworkManager.getCustomer(pageId, customerId!, req.accessTokenString!, true);
            if (!customer){
                throw new BadRequestError('Post author is not defined'); 
            } else {
                customer.properties.map(async (property: any) => {
                    if (property.id == 1 ) {
                        name = property.value;
                    }
                });
            }
        }
        const pageProperties = await PostPropertyEntity.find({ where: { pageId: pageId, postType: post.postType } })
        const properties: PropertyParam[] = req.body.properties;

        const validProperties = PropertiesManager.validateProperties(pageProperties, properties, false);
        if (validProperties instanceof Error){
            throw validProperties;
        }

        const oldPostProperties = post.properties;
        post.properties = {};
        for (const validProperty of validProperties) {
            let userCanUpdate = true;

            for (const pageProperty of pageProperties) {
                if (pageProperty.id == validProperty.id){
                    userCanUpdate = pageProperty.userCanUpdate;
                }
                if(!customerAccessToken && validProperty.id === 31) {
                    userCanUpdate = true;
                }
            }

            if (userCanUpdate){
                if(validProperty.id == 2) {
                  title = validProperty.value.toJSON();
                }
                if(validProperty.id == 3) {
                    const image = new Image;
                    await image.ShareImage(validProperty, accessToken, title!, name! );
                }
                if (validProperty.id == 37) {
                    for (let object in validProperty.value.toJSON()) {
                        const result = await checkOnPost(postId, object);
                        if (result == false) {
                            await createPostCategory(post._id, object, post.properties[7].value);
                        }
                    }
                    await deleteOldCategory(postId, validProperty.value.toJSON())
                }
                post.properties[validProperty.id] = {id:validProperty.id, name:validProperty.name, type:validProperty.type, value:validProperty.value.toJSON()};
            }
        }

        const found = validProperties.some((property: any) => property.id === 38);
        if (!found) {
            pageProperties.map((property: any) => {
                if (property.id == 38) {
                    post.properties[property.id] = { id: property.id, name: property.name, type: property.type, value: false }
                }
            });
        }

        if (oldPostProperties!=undefined){
            // fill with properties like uniqueId, and for iteractions
            for (const pageProperty of pageProperties) {
                if (pageProperty.id != undefined && pageProperty.userCanUpdate == false && Object.prototype.hasOwnProperty.call(oldPostProperties, pageProperty.id)){
                    if (pageProperty.id != 31) {
                        post.properties[pageProperty.id] = oldPostProperties[pageProperty.id];
                    }
                }
            }
        }

        await post.save();

        const response = {
            post: post
        };

        res.status(200).send(response);
    }
);

router.post(
    '/api/v4/pages/:pageId/posts/:postId/status', 
    [
        body('status')
            .isIn([PostStatus.ACTIVE, PostStatus.DRAFT])
            .withMessage('Status is unsupported')
    ],
    validateRequest,
    validatePagePermissions(true, true, true, [UserRole.ADMIN, UserRole.CREATOR], false),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const postId = req.params?.postId;
        const status: PostStatus = req.body.status;

        let post = await Post.findById(postId);
        if (!post || post.pageId != pageId || post.status == PostStatus.REMOVED){
            throw new BadRequestError('Post not found');
        }

        if (req.customerAccessToken && req.customerAccessToken.customerId!=post.ownerId){
            throw new PermissionError();
        }

        if (pageId == +process.env.FEEDC_PAGE_ID!){
            //Feedc
            if (status==PostStatus.ACTIVE && post.properties!=undefined){
                let updateQuery: any = {};
                const contentKey = +process.env.FEEDC_POST_UNIQUE_ID_PROPERTY_ID!;
                if (Object.prototype.hasOwnProperty.call(post.properties, contentKey) == false) {
                    const uniqueId = await PostsHelper.generateUniqueId(post.properties[process.env.FEEDC_POST_TITLE_PROPERTY_ID!].value, post.id);

                    let validProperty = new ValidProperty(contentKey, `uniqueId`, PropertyType.TEXT, new TextProperty(uniqueId));
                    updateQuery[`properties.${contentKey}`] = {id:validProperty.id, name:validProperty.name, type:validProperty.type, value:validProperty.value.toJSON()};
        
                    await Post.findByIdAndUpdate(postId, updateQuery);    
                }    
            }
        }

        post.status = status;
        await post.save();

        post = await Post.findById(postId);

        const response = {
            post: post
        };

        res.status(200).send(response);
    }
);

router.get(
    '/api/v4/pages/:pageId/posts/:postId', 
    validatePagePermissions(true, true, true, [UserRole.ADMIN, UserRole.CREATOR], false),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const postId = req.params?.postId;

        const post = await Post.findById(postId);
        if (!post || post.pageId != pageId || post.status == PostStatus.REMOVED){
            throw new BadRequestError('Post not found');
        }

        const response = {
            post: post
        };

        res.status(200).send(response);
    }
);

router.get(
    '/api/v4/pages/:pageId/posts', 
    validatePagePermissions(true, true, false, [UserRole.ADMIN, UserRole.CREATOR]),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const pageToken = PageToken.parse(req.query?.pageToken?.toString());

        let pageIndex = (pageToken!=undefined) ? (pageToken.pageIndex+1) : 0;
        let pageSize = (pageToken!=undefined) ? pageToken.pageSize : 10;

        let posts: IPost[];
        let postsCount = 0;
        try {
            posts = await Post.find()
                .where('pageId').equals(pageId)
                .where('status').in([PostStatus.DRAFT, PostStatus.ACTIVE])
                .sort({'properties.7.value': -1})
                .limit(pageSize)
                .skip(pageSize*pageIndex)
                .exec();

            //TODO: BUG change to countDocuments
            postsCount = await Post.count()
                .where('pageId').equals(pageId)
                .where('status').ne(PostStatus.REMOVED)
                .exec();

        } catch (err) {
            throw new BadRequestError('Bad request');
        }

        const hasMore = (postsCount > pageSize*(pageIndex+1));
        const newPageToken: PageToken = new PageToken(pageIndex, pageSize);

        const response = {
            hasMore: hasMore,
            pageToken: newPageToken,
            postsCount: postsCount,
            posts: posts
        };

        res.status(200).send(response);
    }
);

// PIN
router.get(
    '/api/v4/pages/:pageId/posts/pin/:uniqueId', 
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const uniqueId = req.params?.uniqueId;

        const post = await Post.findOne()
            .where('pageId').equals(pageId)
            .where('postType').equals(1)
            .where('status').equals(PostStatus.ACTIVE)
            .where('properties.29.value').equals(uniqueId);

        
        if (!post){
            throw new BadRequestError('Post not found');
        }

        post.pinned = true;
        await post.save();

        res.status(200).send({ success: true });
    }
);


router.get(
    '/api/v4/pages/:pageId/posts/unpin/:uniqueId', 
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const uniqueId = req.params?.uniqueId;

        const post = await Post.findOne()
            .where('pageId').equals(pageId)
            .where('postType').equals(1)
            .where('status').equals(PostStatus.ACTIVE)
            .where('properties.29.value').equals(uniqueId);

        
        if (!post){
            throw new BadRequestError('Post not found');
        }

        post.pinned = false;
        await post.save();

        res.status(200).send({ success: true });
    }
);

// HIDE
router.get(
    '/api/v4/pages/:pageId/posts/hide/:uniqueId', 
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const uniqueId = req.params?.uniqueId;

        const post = await Post.findOne()
            .where('pageId').equals(pageId)
            .where('postType').equals(1)
            .where('status').equals(PostStatus.ACTIVE)
            .where('properties.29.value').equals(uniqueId);

        
        if (!post){
            throw new BadRequestError('Post not found');
        }

        let updateQuery: any = {};
        const contentKey = 31;
        if (Object.prototype.hasOwnProperty.call(post.properties, contentKey) == false) {
            let validProperty = new ValidProperty(contentKey, `isHidden`, PropertyType.BOOLEAN, new BooleanProperty(true));
            updateQuery[`properties.${contentKey}`] = {id:validProperty.id, name:validProperty.name, type:validProperty.type, value:validProperty.value.toJSON()};
        }  
        else{
            updateQuery[`properties.${contentKey}.value`] = true;    
        }  
        await Post.findByIdAndUpdate(post.id, updateQuery);    

        await PostCategory.deleteMany({ postId: post.id })

        res.status(200).send({ success: true });
    }
);


router.get(
    '/api/v4/pages/:pageId/posts/unhide/:uniqueId', 
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const uniqueId = req.params?.uniqueId;

        const post = await Post.findOne()
            .where('pageId').equals(pageId)
            .where('postType').equals(1)
            .where('status').equals(PostStatus.ACTIVE)
            .where('properties.29.value').equals(uniqueId);

        
        if (!post){
            throw new BadRequestError('Post not found');
        }

        let updateQuery: any = {};
        const contentKey = 31;
        updateQuery[`properties.${contentKey}.value`] = false;
        await Post.findByIdAndUpdate(post.id, updateQuery);    

        res.status(200).send({ success: true });
    }
);

router.delete(
    '/api/v4/pages/:pageId/posts/owner/:customerId', 
    validatePagePermissions(true, true, true, [UserRole.ADMIN], true),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        const customerId = req.params?.customerId;
        let posts: IPost[] = [];

        let postsQuery = Post.find();
        postsQuery = postsQuery.where('pageId').equals(pageId);
        postsQuery = postsQuery.where('ownerId').equals(customerId);
        postsQuery = postsQuery.where('status').equals(PostStatus.ACTIVE);
        posts = await postsQuery.exec();
 
        if(posts.length > 0) {
            posts.map(async (post) => {
                post.status = PostStatus.REMOVED;
                await post.save();
                return post;
            });
        }
        res.status(200).send(posts);
    }
);

export { router as postsRouterV4 };